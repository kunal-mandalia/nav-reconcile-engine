from dataclasses import replace

from agent_helpers import scripted_models
from conftest import headers, uid
from fastapi.testclient import TestClient
from pydantic_ai.models.function import FunctionModel

from fund_service.agent.policy import AgentPolicy, AgentSettings
from fund_service.app import create_app
from fund_service.worker import process


def test_agent_policy_frozen_publication_audit_and_idempotency(settings):
    configured = replace(
        settings, seed_agent_demo=True, agent=AgentSettings(AgentPolicy(mode="assist"))
    )
    with TestClient(create_app(configured, run_worker=False)) as client:
        actor = headers(funds=[uid(7)], key="agent-fixture-run")
        body = {"reconciliation_period_id": uid(107)}
        response = client.post(f"/internal/v1/funds/{uid(7)}/runs", headers=actor, json=body)
        assert response.status_code == 202
        current = response.json()
        assert current["processing"]["mode"] == "agent"
        repo = client.app.state.repository
        row = repo.claim()
        assert row["input_snapshot"]["agent_policy"]["toolset"] == "whole-file-v1"
        assert "api_key" not in str(row["input_snapshot"])
        # A config change after admission does not change the queued run's policy.
        repo.agent_policy = AgentPolicy(mode="off")
        process(
            repo,
            row,
            settings.source_dir,
            models=scripted_models(row["input_snapshot"], settings.source_dir),
        )
        finished = client.get(
            current["poll_url"].replace("/api/v1", "/internal/v1"), headers=actor
        ).json()
        assert finished["outcome"] == "mismatch"
        assert finished["summary"]["difference"] == "75000.000000"
        assert finished["processing"]["verification"] == "visual_passed"
        assert finished["processing"]["model_requests"] == 5
        assert finished["processing"]["tool_calls"] == 3
        assert finished["facts"][0]["locator"]["kind"] == "csv_record"
        for source in finished["sources"]:
            assert (
                client.get(
                    source["content_url"].replace("/api/v1", "/internal/v1"), headers=actor
                ).status_code
                == 200
            )
        replay = client.post(f"/internal/v1/funds/{uid(7)}/runs", headers=actor, json=body)
        assert replay.status_code == 200 and replay.json() == finished
        with repo.pool.connection() as conn:
            audit = conn.execute(
                "SELECT agent_trace FROM reconciliation_run WHERE id=%s", (finished["run_id"],)
            ).fetchone()["agent_trace"]
            assert len(audit["source_candidates"]) == 10
            assert len(audit["visual_reading"]["facts"]) == 5
            assert (
                conn.execute(
                    "SELECT count(*) AS n FROM extracted_fact WHERE run_id=%s",
                    (finished["run_id"],),
                ).fetchone()["n"]
                == 5
            )


def test_provider_failure_and_deterministic_mode_never_fallback_silently(settings):
    configured = replace(
        settings, seed_agent_demo=True, agent=AgentSettings(AgentPolicy(mode="assist"))
    )
    with TestClient(create_app(configured, run_worker=False)) as client:
        repo = client.app.state.repository
        actor = headers(funds=[uid(7)], key="failing-provider")
        response = client.post(
            f"/internal/v1/funds/{uid(7)}/runs",
            headers=actor,
            json={"reconciliation_period_id": uid(107)},
        )

        def fail(*args):
            raise RuntimeError("secret provider body must not reach response")

        process(
            repo, repo.claim(), settings.source_dir, models={"interpreter": FunctionModel(fail)}
        )
        failed = client.get(
            response.json()["poll_url"].replace("/api/v1", "/internal/v1"), headers=actor
        ).json()
        assert failed["state"] == "failed"
        assert failed["error"]["code"] == "AGENT_PROVIDER_FAILED"
        assert "secret provider" not in str(failed)
        assert "facts" not in failed
        assert failed["processing"]["model_requests"] == 1
        repo.agent_policy = AgentPolicy(mode="off")
        response = client.post(
            f"/internal/v1/funds/{uid(7)}/runs",
            headers=headers(funds=[uid(7)], key="deterministic-next"),
            json={"reconciliation_period_id": uid(107)},
        )
        process(
            repo, repo.claim(), settings.source_dir, models={"interpreter": FunctionModel(fail)}
        )
        finished = client.get(
            response.json()["poll_url"].replace("/api/v1", "/internal/v1"), headers=actor
        ).json()
        assert finished["outcome"] == "insufficient_evidence"
        assert finished["processing"]["mode"] == "deterministic"
        assert finished["processing"]["model_requests"] == 0


def test_agent_csv_only_pack_uses_source_checks_not_visual_claims(client, settings):
    repo = client.app.state.repository
    repo.agent_policy = AgentPolicy(mode="assist")
    response = client.post(
        f"/internal/v1/funds/{uid(1)}/runs",
        headers=headers(key="csv-agent-run"),
        json={"reconciliation_period_id": uid(101)},
    )
    row = repo.claim()
    models = scripted_models(row["input_snapshot"], settings.source_dir)

    def no_visual_call(*args):
        raise AssertionError("CSV-only packs must not claim a PDF visual check")

    models["verifier"] = FunctionModel(no_visual_call)
    process(repo, row, settings.source_dir, models=models)
    finished = client.get(
        response.json()["poll_url"].replace("/api/v1", "/internal/v1"), headers=headers()
    ).json()
    assert finished["outcome"] == "mismatch"
    assert finished["summary"]["difference"] == "250000.000000"
    assert finished["processing"]["verification"] == "source_checked"
    assert finished["processing"]["model_requests"] == 4
    assert all(f["locator"]["kind"] == "csv" for f in finished["facts"])
