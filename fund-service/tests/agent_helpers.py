"""Scripted providers for offline tests. Never imported by production runtime."""

import json

from pydantic_ai.messages import ModelResponse, ToolCallPart, UserPromptPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage

from fund_service.agent.readers import WholeFileReader
from fund_service.agent.schemas import Candidate, Extraction, VisualFact, VisualReading
from fund_service.agent.verification import LABELS
from fund_service.config import ROOT
from fund_service.reconcile import HEADER
from fund_service.sources import digest, store


def pack(root, *, variant="baseline"):
    manifest = json.loads((ROOT / "agent_fixtures/manifest.json").read_text())
    item = manifest["funds"][0]
    source_root = ROOT.parent / "docs/proposals/fixtures/harbor-infrastructure-iii"
    csv_name = (
        "capital_account_matched.csv" if variant == "matched" else "capital_account_messy.csv"
    )
    pdf_name = {
        "baseline": "quarterly_report.pdf",
        "matched": "quarterly_report_matched.pdf",
        "conflict": "quarterly_report_conflict.pdf",
    }[variant]
    docs = []
    for template, name in zip(item["documents"], [csv_name, pdf_name]):
        data = (source_root / name).read_bytes()
        docs.append(
            {
                **template,
                "filename": name,
                "storage_key": store(root, data),
                "sha256": digest(data),
                "byte_size": len(data),
            }
        )
    return {
        "fund": item["fund"],
        "inputs": {
            "period_start": "2026-04-01",
            "period_end": "2026-06-30",
            "entity_scope": "fund",
            "currency": "USD",
            "absolute_tolerance": "0.010000",
        },
        "documents": docs,
    }


def candidates_for(snapshot, root):
    reader = WholeFileReader(snapshot, root)
    result = []
    for doc in snapshot["documents"]:
        content = reader.read_file(doc["document_id"])["content"]
        if content["kind"] == "csv":
            records = content["records"]
            if records[0]["cells"] == HEADER:
                for row in records[1:]:
                    cells = row["cells"]
                    result.append(
                        Candidate(
                            field=cells[5],
                            document_id=doc["document_id"],
                            raw_text=cells[6],
                            scale=cells[4],
                            record=row["record"],
                            column=7,
                        )
                    )
            else:
                for field, record in zip(LABELS, records[12:17]):
                    result.append(
                        Candidate(
                            field=field,
                            document_id=doc["document_id"],
                            raw_text=record["cells"][1],
                            scale="1000",
                            record=record["record"],
                            column=2,
                        )
                    )
        else:
            page = content["pages"][2]
            for field, y in zip(LABELS, [255, 298, 341, 384, 427]):
                word = next(
                    w
                    for w in page["words"]
                    if 360 < w["bbox"][0] < 438 and abs(w["bbox"][1] - y) < 5
                )
                result.append(
                    Candidate(
                        field=field,
                        document_id=doc["document_id"],
                        raw_text=word["text"],
                        scale="1000",
                        page=3,
                        word=word["word"],
                    )
                )
    return result


def scripted_models(snapshot, root, *, vision_error=False, commentary_error=False, candidates=None):
    candidates = candidates if candidates is not None else candidates_for(snapshot, root)
    step = 0

    def interpreter(messages, info):
        nonlocal step
        step += 1
        if step == 1:
            return ModelResponse(
                usage=RequestUsage(input_tokens=1000, output_tokens=100),
                parts=[ToolCallPart("list_files", {})],
            )
        if step == 2:
            return ModelResponse(
                usage=RequestUsage(input_tokens=1000, output_tokens=100),
                parts=[
                    ToolCallPart(
                        "read_file", {"document_id": d["document_id"]}, tool_call_id=f"read-{i}"
                    )
                    for i, d in enumerate(snapshot["documents"])
                ],
            )
        return ModelResponse(
            usage=RequestUsage(input_tokens=1000, output_tokens=100),
            parts=[
                ToolCallPart(
                    info.output_tools[0].name, Extraction(candidates=candidates).model_dump()
                )
            ],
        )

    def verifier(messages, info):
        # Blinded prompt includes only document IDs / page labels and original images.
        prompt = messages[0].parts[-1].content
        assert all(
            "87,700" not in part and "87700000" not in part
            for part in prompt
            if isinstance(part, str)
        )
        facts = [
            VisualFact(
                field=c.field,
                document_id=c.document_id,
                page=c.page,
                raw_text="87,701" if vision_error and c.field == "reported_nav" else c.raw_text,
                scale=c.scale,
            )
            for c in candidates
            if c.page
        ]
        result = VisualReading(
            fund_name=snapshot["fund"]["name"],
            period_start="2026-04-01",
            period_end="2026-06-30",
            currency="USD",
            entity_scope="fund",
            facts=facts,
            uncertain=False,
        )
        return ModelResponse(
            usage=RequestUsage(input_tokens=1000, output_tokens=100),
            parts=[ToolCallPart(info.output_tools[0].name, result.model_dump(mode="json"))],
        )

    def commentator(messages, info):
        if commentary_error:
            raise RuntimeError("simulated provider failure")
        prompt = next(p.content for m in messages for p in m.parts if isinstance(p, UserPromptPart))
        result = json.loads(prompt)
        plan = {
            "outcome": result["outcome"],
            "check_ids": [c["check_id"] for c in result["checks"]],
            "fact_ids": [f["fact_id"] for f in result["facts"]],
            "next_action": {
                "matched": "review",
                "mismatch": "request_explanation",
                "insufficient_evidence": "resolve_inputs",
            }[result["outcome"]],
        }
        return ModelResponse(
            usage=RequestUsage(input_tokens=1000, output_tokens=100),
            parts=[ToolCallPart(info.output_tools[0].name, plan)],
        )

    return {
        "interpreter": FunctionModel(interpreter),
        "verifier": FunctionModel(verifier),
        "commentator": FunctionModel(commentator),
    }
