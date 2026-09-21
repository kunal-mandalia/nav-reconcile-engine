from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from decimal import Decimal
from time import monotonic, sleep

import pytest
from conftest import headers, uid
from fastapi.testclient import TestClient
from psycopg.errors import UniqueViolation

from fund_service.app import create_app
from fund_service.worker import process


def funds(client):
    response = client.get("/internal/v1/funds", headers=headers())
    assert response.status_code == 200, response.text
    return response.json()["funds"]


def start(client, n=1, key="intent-one"):
    return client.post(
        f"/internal/v1/funds/{uid(n)}/runs",
        headers=headers(key=key),
        json={"reconciliation_period_id": uid(n + 100)},
    )


def run(client, run_id, **scope):
    return client.get(f"/internal/v1/runs/{run_id}", headers=headers(**scope))


def test_contracts_real_extraction_provenance_and_numeric_storage(client):
    rows = funds(client)
    assert [r["display_status"] for r in rows] == [
        "mismatch",
        "matched",
        "insufficient_evidence",
        "matched",
        "not_run",
        "run_failed",
    ]
    atlas = run(client, rows[0]["latest_run_id"]).json()
    assert atlas["summary"]["difference"] == "250000.000000"
    assert atlas["inputs"]["absolute_tolerance"] == "0.010000"
    for fact in atlas["facts"]:
        source = next(s for s in atlas["sources"] if s["document_id"] == fact["document_id"])
        response = client.get(
            source["content_url"].replace("/api/v1", "/internal/v1"), headers=headers()
        )
        assert response.status_code == 200
        import csv
        import io

        records = list(csv.DictReader(io.StringIO(response.text)))
        assert records[fact["locator"]["record_number"] - 1]["value"] == fact["raw_text"]
    missing = run(client, rows[2]["latest_run_id"]).json()
    assert missing["summary"]["calculated_nav"] is None
    assert missing["checks"][1]["reason_code"] == "MISSING_NET_INCOME"
    failed = run(client, rows[5]["latest_run_id"]).json()
    assert failed["outcome"] is None and "summary" not in failed
    assert failed["error"]["code"] == "SOURCE_DECODE_FAILED"
    with client.app.state.repository.pool.connection() as conn:
        value = conn.execute(
            "SELECT amount FROM extracted_fact WHERE field='reported_nav' AND run_id=%s",
            (atlas["run_id"],),
        ).fetchone()["amount"]
        assert isinstance(value, Decimal) and value == Decimal("128450000.000000")


def test_service_identity_scope_and_command_validation(client):
    assert client.get("/internal/v1/funds").status_code == 401
    assert (
        client.get(
            "/internal/v1/funds", headers={"Authorization": "Bearer demo-operations"}
        ).status_code
        == 401
    )
    limited = headers(funds=[uid(2), uid(4)], can_run=False, actor="priya-shah")
    assert len(client.get("/internal/v1/funds", headers=limited).json()["funds"]) == 2
    atlas = run(client, funds(client)[0]["latest_run_id"]).json()
    assert (
        client.get(
            atlas["poll_url"].replace("/api/v1", "/internal/v1"), headers=limited
        ).status_code
        == 403
    )
    assert (
        client.get(
            atlas["sources"][0]["content_url"].replace("/api/v1", "/internal/v1"), headers=limited
        ).status_code
        == 403
    )
    limited["Idempotency-Key"] = "readonly-key"
    assert (
        client.post(
            f"/internal/v1/funds/{uid(2)}/runs",
            headers=limited,
            json={"reconciliation_period_id": uid(102)},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/internal/v1/funds/{uid(1)}/runs",
            headers=headers(key="override-key"),
            json={"reconciliation_period_id": uid(101), "tolerance": "100"},
        ).status_code
        == 422
    )
    assert (
        client.get("/internal/v1/funds?period_start=2026-04-01", headers=headers()).status_code
        == 422
    )
    assert (
        client.get("/internal/v1/funds", headers=headers()).headers["x-request-id"]
        == "test-request-123"
    )


def test_concurrent_idempotency_admission_and_immutable_history(client, settings):
    previous = run(client, funds(client)[0]["latest_run_id"]).json()
    with ThreadPoolExecutor(max_workers=4) as executor:
        responses = list(executor.map(lambda _: start(client), range(4)))
    assert [r.status_code for r in responses] == [202] * 4
    current = responses[0].json()
    assert len({r.json()["run_id"] for r in responses}) == 1
    assert start(client, key="another-intent").status_code == 409
    assert start(client, n=2).json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert funds(client)[0]["last_completed_run_id"] == previous["run_id"]
    repository = client.app.state.repository
    process(repository, repository.claim(), settings.source_dir)
    replay = start(client)
    assert replay.status_code == 200 and replay.json()["run_id"] == current["run_id"]
    assert replay.json()["summary"] == previous["summary"]
    assert run(client, previous["run_id"]).json() == previous
    with repository.pool.connection() as conn:
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM idempotency_record WHERE actor_id='alex-chen'"
            ).fetchone()["n"]
            == 1
        )


def test_restart_preserves_results_and_keys_but_fails_interrupted_runs(settings):
    with TestClient(create_app(settings, run_worker=False)) as first:
        complete = run(first, funds(first)[1]["latest_run_id"]).json()
        queued = start(first).json()
    with TestClient(create_app(settings, run_worker=False)) as second:
        assert run(second, complete["run_id"]).json() == complete
        replay = start(second)
        assert replay.status_code == 200 and replay.json()["run_id"] == queued["run_id"]
        assert replay.json()["error"]["code"] == "PROCESS_INTERRUPTED"
        assert start(second, key="new-intent-after-restart").status_code == 202


def test_queue_capacity_and_source_membership(client, settings):
    client.app.state.repository.capacity = 1
    first = start(client)
    assert first.status_code == 202
    assert start(client).status_code == 202  # replay succeeds even at capacity
    assert start(client, n=2, key="capacity-test").status_code == 503
    repo = client.app.state.repository
    process(repo, repo.claim(), settings.source_dir)
    assert (
        start(client, n=2, key="capacity-test").status_code == 202
    )  # rejected key wasn't consumed
    atlas = run(client, first.json()["run_id"]).json()
    assert (
        client.get(
            f"/internal/v1/runs/{atlas['run_id']}/sources/{uid(1010)}", headers=headers()
        ).status_code
        == 404
    )
    row = repo.snapshot({"id": "alex", "fund_ids": [uid(1)], "can_run": True}, atlas["run_id"])
    source = settings.source_dir / row["input_snapshot"]["documents"][0]["storage_key"]
    source.chmod(0o644)
    source.write_text("tampered bytes")
    response = client.get(
        atlas["sources"][0]["content_url"].replace("/api/v1", "/internal/v1"), headers=headers()
    )
    assert (
        response.status_code == 409
        and response.json()["error"]["code"] == "SOURCE_INTEGRITY_FAILED"
    )
    assert run(client, atlas["run_id"]).json() == atlas


def test_failed_publication_rolls_back_facts_and_decision(client, settings):
    from fund_service.reconcile import decide, extract

    repo = client.app.state.repository
    current = start(client).json()
    row = repo.claim()
    facts, issues = extract(row["input_snapshot"], settings.source_dir)
    result = decide(row["input_snapshot"], current["run_id"], facts, issues)
    result["facts"][1]["fact_id"] = result["facts"][0]["fact_id"]  # fail after the first INSERT
    with pytest.raises(UniqueViolation):
        repo.publish(current["run_id"], result)
    with repo.pool.connection() as conn:
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM extracted_fact WHERE run_id=%s", (current["run_id"],)
            ).fetchone()["n"]
            == 0
        )
    assert run(client, current["run_id"]).json()["state"] == "running"


def test_real_background_worker_completes_without_status_reads(settings):
    with TestClient(create_app(replace(settings, seed_demo=True))) as client:
        current = start(client, n=5).json()
        deadline = monotonic() + 5
        while monotonic() < deadline:
            with client.app.state.repository.pool.connection() as conn:
                state = conn.execute(
                    "SELECT state FROM reconciliation_run WHERE id=%s", (current["run_id"],)
                ).fetchone()["state"]
            if state == "completed":
                break
            sleep(0.05)
        assert state == "completed"
        finished = run(client, current["run_id"]).json()
        assert finished["summary"]["difference"] == "-85000.000000"
