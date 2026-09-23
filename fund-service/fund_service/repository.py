import hashlib
from datetime import UTC, datetime
from uuid import uuid4

from psycopg.types.json import Jsonb

from .agent.policy import AgentPolicy
from .contracts import validate
from .db import ADMISSION_LOCK
from .errors import ServiceError
from .reconcile import money


def timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def authorise(actor: dict, fund_id: str, write=False):
    if fund_id not in actor["fund_ids"] or (write and not actor["can_run"]):
        raise ServiceError(
            403, "FUND_ACCESS_DENIED", "Your identity does not have access to this fund action."
        )


def payload(row: dict) -> dict:
    snapshot = row["input_snapshot"]
    result = {
        "schema_version": 1,
        "run_id": str(row["id"]),
        "reconciliation_period_id": str(row["reconciliation_period_id"]),
        "pack_id": str(row["pack_id"]),
        "fund": snapshot["fund"],
        "inputs": snapshot["inputs"],
        "state": row["state"],
        "stage": row["stage"],
        "outcome": row["outcome"],
        "created_at": timestamp(row["created_at"]),
        "stage_updated_at": timestamp(row["stage_updated_at"]),
        "poll_url": f"/api/v1/runs/{row['id']}",
    }
    policy = snapshot.get("agent_policy", {"mode": "off"})
    trace = row.get("agent_trace") or {}
    result["processing"] = {
        "mode": "agent" if policy["mode"] == "assist" else "deterministic",
        "model": policy.get("model") if policy["mode"] == "assist" else None,
        "toolset": policy.get("toolset") if policy["mode"] == "assist" else None,
        "verification": "not_applicable" if policy["mode"] == "off" else "pending",
        "commentary": "template",
        "model_requests": 0,
        "tool_calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        **trace.get("summary", {}),
    }
    if row["completed_at"]:
        result["completed_at"] = timestamp(row["completed_at"])
    if row["state"] == "failed":
        result["error"] = row["error"]
    if row["state"] == "completed":
        result.update(row["result"])
    return validate("Run", result)


class Repository:
    def __init__(self, pool, capacity=8, agent_policy=None):
        self.pool, self.capacity = pool, capacity
        self.agent_policy = agent_policy or AgentPolicy()

    @staticmethod
    def _run(conn, run_id):
        row = conn.execute("SELECT * FROM reconciliation_run WHERE id = %s", (run_id,)).fetchone()
        if not row:
            raise ServiceError(404, "RESOURCE_NOT_FOUND", "Run not found.")
        return row

    def get(self, actor, run_id):
        with self.pool.connection() as conn:
            row = self._run(conn, run_id)
            authorise(actor, row["input_snapshot"]["fund"]["fund_id"])
            return payload(row)

    def snapshot(self, actor, run_id):
        with self.pool.connection() as conn:
            row = self._run(conn, run_id)
            authorise(actor, row["input_snapshot"]["fund"]["fund_id"])
            return row

    def list(self, actor, start, end):
        with self.pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT f.*, p.id AS period_id, k.id AS pack_id, k.version, k.state AS pack_state,
                    latest.id AS latest_id, latest.state, latest.outcome, latest.created_at,
                    completed.id AS completed_id, completed.reported_nav, completed.difference,
                    completed.result
                FROM fund f JOIN reconciliation_period p ON p.fund_id=f.id
                LEFT JOIN pack k ON k.id=p.current_pack_id
                LEFT JOIN LATERAL (SELECT * FROM reconciliation_run r WHERE r.reconciliation_period_id=p.id
                    AND r.pack_id=k.id ORDER BY sequence DESC LIMIT 1) latest ON true
                LEFT JOIN LATERAL (SELECT * FROM reconciliation_run r WHERE r.reconciliation_period_id=p.id
                    AND r.pack_id=k.id AND r.state='completed' ORDER BY sequence DESC LIMIT 1) completed ON true
                WHERE f.id=ANY(%s::uuid[]) AND p.period_start=%s AND p.period_end=%s ORDER BY f.id
            """,
                (actor["fund_ids"], start, end),
            ).fetchall()
        funds = []
        for row in rows:
            status = (
                "no_pack"
                if not row["pack_id"]
                else "awaiting_documents"
                if row["pack_state"] == "needs_input"
                else "processing_failed"
                if row["pack_state"] == "failed"
                else "not_run"
                if row["state"] is None
                else row["outcome"]
                if row["state"] == "completed"
                else "run_failed"
                if row["state"] == "failed"
                else row["state"]
            )
            reasons = {
                "matched": "Capital roll-forward matched",
                "mismatch": "Outside the 0.01 tolerance",
                "insufficient_evidence": "Missing or unresolved source inputs",
                "run_failed": "Processing stopped before a decision",
                "not_run": "Ready for first reconciliation",
                "no_pack": "No selected pack",
                "awaiting_documents": "Pack needs input",
                "processing_failed": "Pack processing failed",
            }
            funds.append(
                {
                    "fund_id": str(row["id"]),
                    "name": row["name"],
                    "administrator": row["administrator"],
                    "strategy": row["strategy"],
                    "currency": row["currency"],
                    "reconciliation_period_id": str(row["period_id"]),
                    "pack": {
                        "pack_id": str(row["pack_id"]),
                        "version": row["version"],
                        "state": row["pack_state"],
                    }
                    if row["pack_id"]
                    else None,
                    "display_status": status,
                    "reported_nav": money(row["reported_nav"])
                    if row["reported_nav"] is not None
                    else None,
                    "difference": money(row["difference"])
                    if row["difference"] is not None
                    else None,
                    "latest_run_id": str(row["latest_id"]) if row["latest_id"] else None,
                    "last_completed_run_id": str(row["completed_id"])
                    if row["completed_id"]
                    else None,
                    "can_rerun": actor["can_run"]
                    and row["pack_state"] == "ready"
                    and status not in {"queued", "running"},
                    "last_run_at": timestamp(row["created_at"]) if row["created_at"] else None,
                    "status_reason": reasons.get(status, "Reconciliation in progress"),
                }
            )
        return validate(
            "FundList",
            {
                "schema_version": 1,
                "period": {"start": str(start), "end": str(end)},
                "funds": funds,
                "processing_mode": "agent"
                if self.agent_policy.mode == "assist"
                else "deterministic",
            },
        )

    def start(self, actor, fund_id, period_id, key, request_id, *, seed_run=False):
        authorise(actor, fund_id, write=True)
        fingerprint = hashlib.sha256(f"start:{fund_id}:{period_id}".encode()).hexdigest()
        with self.pool.connection() as conn:
            # Serialises short admission transactions, including same-key/different-period races.
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (ADMISSION_LOCK,))
            previous = conn.execute(
                "SELECT * FROM idempotency_record WHERE actor_id=%s AND operation='start' AND key=%s",
                (actor["id"], key),
            ).fetchone()
            if previous:
                if previous["request_hash"] != fingerprint:
                    raise ServiceError(
                        409,
                        "IDEMPOTENCY_KEY_REUSED",
                        "This key was already used for a different request.",
                    )
                return payload(self._run(conn, previous["run_id"]))
            period = conn.execute(
                """SELECT p.*, f.name, f.administrator, f.strategy FROM reconciliation_period p
                JOIN fund f ON f.id=p.fund_id WHERE p.id=%s AND f.id=%s FOR UPDATE OF p""",
                (period_id, fund_id),
            ).fetchone()
            if not period:
                raise ServiceError(
                    404, "RESOURCE_NOT_FOUND", "The reporting period does not belong to this fund."
                )
            pack = conn.execute(
                "SELECT * FROM pack WHERE id=%s", (period["current_pack_id"],)
            ).fetchone()
            if not pack or pack["state"] != "ready":
                raise ServiceError(
                    409, "PACK_NOT_READY", "The selected pack is not ready for reconciliation."
                )
            active = conn.execute(
                "SELECT id FROM reconciliation_run WHERE reconciliation_period_id=%s AND state IN ('queued','running')",
                (period_id,),
            ).fetchone()
            if active:
                raise ServiceError(
                    409,
                    "RUN_ALREADY_ACTIVE",
                    "A reconciliation is already running for this fund and period.",
                    {"run_id": str(active["id"])},
                )
            count = conn.execute(
                "SELECT count(*) AS n FROM reconciliation_run WHERE state IN ('queued','running')"
            ).fetchone()["n"]
            if count >= self.capacity:
                raise ServiceError(
                    503,
                    "QUEUE_FULL",
                    "The reconciliation queue is full. Retry this request shortly.",
                )
            documents = conn.execute(
                "SELECT * FROM document WHERE pack_id=%s ORDER BY id", (pack["id"],)
            ).fetchall()
            if not documents:
                raise ServiceError(
                    409, "PACK_NOT_READY", "The selected pack has no registered source documents."
                )
            snapshot = {
                "schema_version": 1,
                "fund": {
                    "fund_id": fund_id,
                    "name": period["name"],
                    "administrator": period["administrator"],
                    "strategy": period["strategy"],
                },
                "inputs": {
                    "pack_id": str(pack["id"]),
                    "pack_version": pack["version"],
                    "period_start": str(period["period_start"]),
                    "period_end": str(period["period_end"]),
                    "entity_scope": period["entity_scope"],
                    "currency": period["currency"],
                    "ruleset_version": period["ruleset_version"],
                    "absolute_tolerance": money(period["tolerance"]),
                },
                "manifest_sha256": pack["manifest_sha256"],
                "extractor_version": "fixed-csv-v1"
                if seed_run or self.agent_policy.mode == "off"
                else "agent-whole-file-v1",
                "agent_policy": (AgentPolicy() if seed_run else self.agent_policy).snapshot(),
                "service_version": "0.1.0",
                "required_checks": ["input_alignment", "capital_roll_forward"],
                "documents": [
                    {
                        "document_id": str(d["id"]),
                        "filename": d["filename"],
                        "storage_key": d["storage_key"],
                        "sha256": d["sha256"],
                        "byte_size": d["byte_size"],
                        "media_type": d["media_type"],
                        "role": d["role"],
                    }
                    for d in documents
                ],
            }
            run_id = str(uuid4())
            row = conn.execute(
                """INSERT INTO reconciliation_run
                (id,reconciliation_period_id,pack_id,input_snapshot,requested_by,request_id,state,stage)
                VALUES (%s,%s,%s,%s,%s,%s,'queued','waiting') RETURNING *""",
                (run_id, period_id, pack["id"], Jsonb(snapshot), actor["id"], request_id),
            ).fetchone()
            conn.execute(
                "INSERT INTO idempotency_record (actor_id,operation,key,request_hash,run_id) VALUES (%s,'start',%s,%s,%s)",
                (actor["id"], key, fingerprint, run_id),
            )
            result = payload(row)
        # The DB queue becomes visible to the worker only after this commit.
        return result

    def claim(self):
        with self.pool.connection() as conn:
            return conn.execute("""UPDATE reconciliation_run SET state='running',stage='extracting',stage_updated_at=clock_timestamp()
                WHERE id=(SELECT id FROM reconciliation_run WHERE state='queued' ORDER BY sequence FOR UPDATE SKIP LOCKED LIMIT 1)
                RETURNING *""").fetchone()

    def stage(self, run_id, stage):
        with self.pool.connection() as conn:
            conn.execute(
                "UPDATE reconciliation_run SET stage=%s, stage_updated_at=clock_timestamp() WHERE id=%s AND state='running'",
                (stage, run_id),
            )

    def publish(self, run_id, result, *, agent_trace=None):
        with self.pool.connection() as conn:
            row = conn.execute(
                "SELECT * FROM reconciliation_run WHERE id=%s FOR UPDATE", (run_id,)
            ).fetchone()
            if row["state"] != "running":
                raise RuntimeError("Only an active worker can publish a decision")
            now = datetime.now(UTC)
            # Validate complete wire shape before inserting any facts or terminal state.
            payload(
                {
                    **row,
                    "state": "completed",
                    "stage": "finished",
                    "outcome": result["outcome"],
                    "result": result,
                    "agent_trace": agent_trace,
                    "completed_at": now,
                    "stage_updated_at": now,
                }
            )
            document_ids = {d["document_id"] for d in row["input_snapshot"]["documents"]}
            for fact in result["facts"]:
                if fact["document_id"] not in document_ids:
                    raise RuntimeError("Fact is outside the frozen manifest")
                conn.execute(
                    """INSERT INTO extracted_fact (id,run_id,document_id,field,raw_text,amount,currency,scale,locator,normalisation_steps)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        fact["fact_id"],
                        run_id,
                        fact["document_id"],
                        fact["field"],
                        fact["raw_text"],
                        fact["amount"],
                        fact["currency"],
                        fact["scale"],
                        Jsonb(fact["locator"]),
                        Jsonb(fact["normalisation_steps"]),
                    ),
                )
            for check in result["checks"]:
                conn.execute(
                    """INSERT INTO check_result (id,run_id,check_type,required,status,reason_code,expected_amount,reported_amount,difference_amount,tolerance_amount,currency,input_fact_ids)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        check["check_id"],
                        run_id,
                        check["type"],
                        check["required"],
                        check["status"],
                        check["reason_code"],
                        check.get("expected_amount"),
                        check.get("reported_amount"),
                        check.get("difference_amount"),
                        check.get("tolerance_amount"),
                        check.get("currency"),
                        Jsonb(check["input_fact_ids"]),
                    ),
                )
            summary = result["summary"]
            conn.execute(
                """UPDATE reconciliation_run SET state='completed',stage='finished',outcome=%s,
                result=%s,agent_trace=%s,reported_nav=%s,calculated_nav=%s,difference=%s,completed_at=%s,stage_updated_at=%s WHERE id=%s""",
                (
                    result["outcome"],
                    Jsonb(result),
                    Jsonb(agent_trace) if agent_trace else None,
                    summary["reported_nav"],
                    summary["calculated_nav"],
                    summary["difference"],
                    now,
                    now,
                    run_id,
                ),
            )

    def fail(self, run_id, code, message, *, agent_trace=None):
        with self.pool.connection() as conn:
            conn.execute(
                """UPDATE reconciliation_run SET state='failed',error=%s,agent_trace=%s,completed_at=clock_timestamp(),stage_updated_at=clock_timestamp()
                WHERE id=%s AND state IN ('queued','running')""",
                (
                    Jsonb({"code": code, "message": message}),
                    Jsonb(agent_trace) if agent_trace else None,
                    run_id,
                ),
            )

    def interrupt_unfinished(self):
        with self.pool.connection() as conn:
            conn.execute(
                """UPDATE reconciliation_run SET state='failed',error=%s,completed_at=clock_timestamp(),stage_updated_at=clock_timestamp()
                WHERE state IN ('queued','running')""",
                (
                    Jsonb(
                        {
                            "code": "PROCESS_INTERRUPTED",
                            "message": "The service stopped before this run published a decision. Start a new run to retry.",
                        }
                    ),
                ),
            )
