from dataclasses import replace

import pytest
from agent_helpers import candidates_for, pack, scripted_models
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from fund_service.agent.policy import AgentPolicy, AgentSettings
from fund_service.agent.readers import RangedReaderPlaceholder, WholeFileReader
from fund_service.agent.runtime import AgentWorkflow
from fund_service.errors import SourceFailure


@pytest.mark.parametrize(
    "variant,outcome,difference",
    [
        ("baseline", "mismatch", "75000.000000"),
        ("matched", "matched", "0.000000"),
        ("conflict", "insufficient_evidence", None),
    ],
)
def test_full_workflow_with_real_files_and_scripted_models(tmp_path, variant, outcome, difference):
    snapshot = pack(tmp_path, variant=variant)
    workflow = AgentWorkflow(AgentPolicy(mode="assist"), models=scripted_models(snapshot, tmp_path))
    stages = []
    result = workflow.run(snapshot, tmp_path, "demo-run", stages.append)
    assert result["outcome"] == outcome
    assert result["summary"]["difference"] == difference
    assert stages == ["normalising", "reconciling"]
    assert workflow.audit["summary"]["model_requests"] <= 5
    assert workflow.audit["summary"]["tool_calls"] == 3
    assert workflow.audit["summary"]["commentary"] == "agent_supported"
    assert len(result["facts"]) == (0 if difference is None else 5)
    if difference is not None:
        assert workflow.audit["summary"]["verification"] == "visual_passed"
        assert all(f["locator"]["kind"] == "csv_record" for f in result["facts"])


def test_visual_disagreement_blocks_all_financial_publication(tmp_path):
    snapshot = pack(tmp_path)
    workflow = AgentWorkflow(
        AgentPolicy(mode="assist"), models=scripted_models(snapshot, tmp_path, vision_error=True)
    )
    result = workflow.run(snapshot, tmp_path, "demo-run", lambda _: None)
    assert result["outcome"] == "insufficient_evidence"
    assert result["summary"] == {"reported_nav": None, "calculated_nav": None, "difference": None}
    assert result["facts"] == []
    assert workflow.audit["issues"] == ["EXTRACTION_DISAGREEMENT"]


def test_commentary_failure_preserves_verified_decision(tmp_path):
    snapshot = pack(tmp_path)
    workflow = AgentWorkflow(
        AgentPolicy(mode="assist"),
        models=scripted_models(snapshot, tmp_path, commentary_error=True),
    )
    result = workflow.run(snapshot, tmp_path, "demo-run", lambda _: None)
    assert result["outcome"] == "mismatch"
    assert result["summary"]["difference"] == "75000.000000"
    assert workflow.audit["summary"]["commentary"] == "template"
    assert "do not explain" in result["commentary"][0]["text"]


@pytest.mark.parametrize(
    "change", ["wrong_column", "invented_value", "wrong_scale", "other_document", "prior_period"]
)
def test_invalid_citations_do_not_become_accepted_facts(tmp_path, change):
    snapshot = pack(tmp_path)
    candidates = candidates_for(snapshot, tmp_path)
    candidate = candidates[0]
    if change == "wrong_column":
        candidate.column = 3
    elif change == "invented_value":
        candidate.raw_text = "999,999"
    elif change == "wrong_scale":
        candidate.scale = "1"
    elif change == "other_document":
        candidate.document_id = "not-in-pack"
    elif change == "prior_period":
        candidate.record = 9
    workflow = AgentWorkflow(
        AgentPolicy(mode="assist"),
        models=scripted_models(snapshot, tmp_path, candidates=candidates),
    )
    result = workflow.run(snapshot, tmp_path, "demo-run", lambda _: None)
    assert result["outcome"] == "insufficient_evidence"
    assert result["facts"] == []


def test_manifest_scope_integrity_limits_and_placeholder(tmp_path):
    snapshot = pack(tmp_path)
    reader = WholeFileReader(snapshot, tmp_path)
    with pytest.raises(SourceFailure, match="outside"):
        reader.read_file("../../.env")
    doc = snapshot["documents"][0]
    file = tmp_path / doc["storage_key"]
    file.chmod(0o644)
    file.write_bytes(b"tampered")
    with pytest.raises(SourceFailure, match="manifest"):
        reader.read_file(doc["document_id"])
    doc["byte_size"] = 2_000_001
    with pytest.raises(SourceFailure, match="Ranged reads"):
        reader.read_file(doc["document_id"])
    with pytest.raises(NotImplementedError):
        RangedReaderPlaceholder().read_range()


def test_shared_request_and_attempted_tool_limits(tmp_path):
    snapshot = pack(tmp_path)
    workflow = AgentWorkflow(
        AgentPolicy(mode="assist", max_requests=1), models=scripted_models(snapshot, tmp_path)
    )
    with pytest.raises(SourceFailure) as error:
        workflow.run(snapshot, tmp_path, "demo-run", lambda _: None)
    assert error.value.code == "AGENT_BUDGET_EXCEEDED"
    assert workflow.audit["summary"]["model_requests"] == 1

    def excessive(messages, info):
        return ModelResponse(parts=[ToolCallPart("unknown_tool", {}) for _ in range(25)])

    workflow = AgentWorkflow(
        AgentPolicy(mode="assist"), models={"interpreter": FunctionModel(excessive)}
    )
    with pytest.raises(SourceFailure) as error:
        workflow.run(snapshot, tmp_path, "demo-run", lambda _: None)
    assert error.value.code == "AGENT_BUDGET_EXCEEDED"
    assert workflow.audit["summary"]["tool_calls"] == 25
    assert workflow.audit["summary"]["input_tokens"] > 0
    assert workflow.audit["summary"]["output_tokens"] > 0


def test_config_requires_key_only_when_enabled(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("AGENT_MODE", "off")
    assert AgentSettings.from_env().policy.mode == "off"
    monkeypatch.setenv("AGENT_MODE", "assist")
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        AgentSettings.from_env()
    monkeypatch.setenv("OPENAI_API_KEY", "test-secret")
    settings = AgentSettings.from_env()
    assert "test-secret" not in repr(settings)
    assert "test-secret" not in str(settings.policy.snapshot())
    with pytest.raises(ValueError):
        replace(settings.policy, max_requests=13)


def test_model_request_timeout_is_a_technical_failure(tmp_path):
    import asyncio

    async def slow(messages, info):
        await asyncio.sleep(2)
        raise AssertionError("Request should have timed out")

    snapshot = pack(tmp_path)
    workflow = AgentWorkflow(
        AgentPolicy(mode="assist", request_timeout_seconds=1),
        models={"interpreter": FunctionModel(slow)},
    )
    with pytest.raises(SourceFailure) as error:
        workflow.run(snapshot, tmp_path, "demo-run", lambda _: None)
    assert error.value.code == "AGENT_TIMEOUT"
    assert workflow.audit["summary"]["model_requests"] == 1


@pytest.mark.parametrize("ambiguity", ["duplicate_field", "duplicate_scope"])
def test_omitted_ambiguous_csv_rows_block_publication(tmp_path, ambiguity):
    import csv
    import io

    from fund_service.sources import digest, read, store

    snapshot = pack(tmp_path)
    candidates = candidates_for(snapshot, tmp_path)
    doc = snapshot["documents"][0]
    rows = list(csv.reader(io.StringIO(read(tmp_path, doc).decode("utf-8-sig"), newline="")))
    if ambiguity == "duplicate_field":
        rows.insert(
            17, ["Closing partners' capital", "90,000", "84,000", "Conflicting current value"]
        )
    else:
        rows.append(["Period", "2025-04-01", "2025-06-30"])
        rows.append(["Period", "2026-04-01", "2026-06-30"])
    out = io.StringIO(newline="")
    csv.writer(out).writerows(rows)
    data = out.getvalue().encode("utf-8-sig")
    doc.update(storage_key=store(tmp_path, data), sha256=digest(data), byte_size=len(data))
    workflow = AgentWorkflow(
        AgentPolicy(mode="assist"),
        models=scripted_models(snapshot, tmp_path, candidates=candidates),
    )
    result = workflow.run(snapshot, tmp_path, "demo-run", lambda _: None)
    assert result["outcome"] == "insufficient_evidence"
    assert result["facts"] == []
