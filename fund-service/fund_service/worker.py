import logging
import threading

from .agent.policy import AgentPolicy, AgentSettings
from .errors import SourceFailure
from .reconcile import decide, extract

log = logging.getLogger(__name__)


def process(repository, row, source_dir, *, agent_settings=None, models=None):
    run_id = str(row["id"])
    workflow = None
    try:
        policy = AgentPolicy(**row["input_snapshot"].get("agent_policy", {}))
        if policy.mode == "assist":
            from .agent.runtime import AgentWorkflow

            workflow = AgentWorkflow(
                policy, api_key=(agent_settings or AgentSettings()).api_key, models=models
            )
            result = workflow.run(
                row["input_snapshot"],
                source_dir,
                run_id,
                lambda stage: repository.stage(run_id, stage),
            )
        else:
            facts, issues = extract(row["input_snapshot"], source_dir)
            repository.stage(run_id, "normalising")
            repository.stage(run_id, "reconciling")
            result = decide(row["input_snapshot"], run_id, facts, issues)
        repository.stage(run_id, "publishing")
        repository.publish(run_id, result, agent_trace=workflow.audit if workflow else None)
        log.info(
            "run_complete run_id=%s request_id=%s outcome=%s",
            run_id,
            row["request_id"],
            result["outcome"],
        )
    except SourceFailure as error:
        repository.fail(
            run_id, error.code, error.message, agent_trace=workflow.audit if workflow else None
        )
    except Exception:
        log.exception("run_failed run_id=%s request_id=%s", run_id, row["request_id"])
        repository.fail(
            run_id,
            "PROCESSING_FAILED",
            "Processing stopped before a decision could be published.",
            agent_trace=workflow.audit if workflow else None,
        )


class Worker:
    """Single bounded DB-backed demo worker; no artificial delays or polling side effects."""

    def __init__(self, repository, source_dir, ownership=None, *, agent_settings=None):
        self.repository, self.source_dir = repository, source_dir
        self.ownership = ownership
        self.agent_settings = agent_settings
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, name="reconciliation-worker", daemon=True)

    def run(self):
        while not self.stop.is_set():
            if self.ownership:
                try:
                    self.ownership.execute("SELECT 1")
                except Exception:
                    log.exception(
                        "Service ownership connection lost; restart the service before accepting work"
                    )
                    self.stop.set()
                    return
            try:
                row = self.repository.claim()
                if row:
                    process(
                        self.repository, row, self.source_dir, agent_settings=self.agent_settings
                    )
                    continue
            except Exception:
                log.exception("Worker database operation failed")
            self.stop.wait(0.2)

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        # Bounded source sizes and SQL timeouts bound normal shutdown work.
        self.thread.join()
