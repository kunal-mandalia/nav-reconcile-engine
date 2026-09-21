import logging
import threading

from .errors import SourceFailure
from .reconcile import decide, extract

log = logging.getLogger(__name__)


def process(repository, row, source_dir):
    run_id = str(row["id"])
    try:
        facts, issues = extract(row["input_snapshot"], source_dir)
        repository.stage(run_id, "normalising")
        repository.stage(run_id, "reconciling")
        result = decide(row["input_snapshot"], run_id, facts, issues)
        repository.stage(run_id, "publishing")
        repository.publish(run_id, result)
        log.info(
            "run_complete run_id=%s request_id=%s outcome=%s",
            run_id,
            row["request_id"],
            result["outcome"],
        )
    except SourceFailure as error:
        repository.fail(run_id, error.code, error.message)
    except Exception:
        log.exception("run_failed run_id=%s request_id=%s", run_id, row["request_id"])
        repository.fail(
            run_id, "PROCESSING_FAILED", "Processing stopped before a decision could be published."
        )


class Worker:
    """Single bounded DB-backed demo worker; no artificial delays or polling side effects."""

    def __init__(self, repository, source_dir, ownership=None):
        self.repository, self.source_dir = repository, source_dir
        self.ownership = ownership
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
                    process(self.repository, row, self.source_dir)
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
