"""Opt-in, bounded live evaluation of the fictional Harbor pack; no database writes.

Run via npm run eval:agent -- --live. The Node launcher loads the ignored root .env.
The oracle stays in this script, outside the model's authorised file manifest.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "fund-service"))

from fund_service.agent.policy import AgentPolicy
from fund_service.agent.runtime import AgentWorkflow
from fund_service.errors import SourceFailure
from fund_service.sources import digest, store

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--live", action="store_true", help="Allow paid OpenAI requests")
parser.add_argument(
    "--report", type=Path, help="Write a local JSON audit without credentials or images"
)
args = parser.parse_args()
if not args.live:
    parser.error("Pass --live to explicitly enable a bounded paid model evaluation")
key = os.environ.get("OPENAI_API_KEY", "").strip()
if not key:
    parser.error("Set OPENAI_API_KEY in the ignored root .env")
fixture_dir = ROOT / "fund-service/agent_fixtures"
manifest = json.loads((fixture_dir / "manifest.json").read_text())
item = manifest["funds"][0]
policy = AgentPolicy(
    mode="assist", model=os.getenv("AGENT_MODEL", "openai:gpt-4.1-mini")
)
workflow = AgentWorkflow(policy, api_key=key)
with TemporaryDirectory(prefix="nav-live-agent-") as temporary:
    root = Path(temporary)
    documents = []
    for doc in item["documents"]:
        data = (fixture_dir / item["fund"]["fund_id"] / doc["filename"]).read_bytes()
        documents.append(
            {
                **doc,
                "storage_key": store(root, data),
                "sha256": digest(data),
                "byte_size": len(data),
            }
        )
    snapshot = {
        "fund": item["fund"],
        "documents": documents,
        "inputs": {
            "period_start": "2026-04-01",
            "period_end": "2026-06-30",
            "currency": "USD",
            "entity_scope": "fund",
            "absolute_tolerance": "0.010000",
        },
    }
    try:
        result = workflow.run(
            snapshot, root, str(uuid4()), lambda stage: print(f"Stage: {stage}")
        )
    except SourceFailure as error:
        if args.report:
            args.report.write_text(json.dumps(workflow.audit, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "status": "failed",
                    "code": error.code,
                    "usage": workflow.audit["summary"],
                    "failure_type": workflow.audit.get("failure_type"),
                },
                indent=2,
            )
        )
        sys.exit(1)
    if args.report:
        args.report.write_text(json.dumps(workflow.audit, indent=2) + "\n")
    expected = {
        "opening_nav": "84000000.000000",
        "capital_calls": "6250000.000000",
        "distributions": "2100000.000000",
        "net_income": "-375000.000000",
        "reported_nav": "87700000.000000",
    }
    passed = (
        result["outcome"] == "mismatch"
        and result["summary"]["difference"] == "75000.000000"
        and {f["field"]: f["amount"] for f in result["facts"]} == expected
        and workflow.audit["summary"]["verification"] == "visual_passed"
    )
    print(
        json.dumps(
            {
                "status": "passed" if passed else "failed",
                "outcome": result["outcome"],
                "summary": result["summary"],
                "usage": workflow.audit["summary"],
                "issues": workflow.audit.get("issues", []),
            },
            indent=2,
        )
    )
    sys.exit(0 if passed else 1)
