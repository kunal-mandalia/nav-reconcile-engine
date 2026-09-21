import hmac
import json
import logging
import re
from contextlib import asynccontextmanager
from datetime import date
from uuid import UUID, uuid4

import psycopg
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from psycopg_pool import PoolTimeout
from pydantic import BaseModel, ConfigDict

from .config import Settings
from .db import SERVICE_LOCK, migrate, open_pool
from .errors import ServiceError, SourceFailure
from .repository import Repository
from .seed import seed
from .sources import read
from .worker import Worker

log = logging.getLogger(__name__)


class StartRun(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reconciliation_period_id: UUID


def create_app(settings: Settings | None = None, *, run_worker=True):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        pool = open_pool(settings.database_url)
        ownership = worker = None
        try:
            migrate(pool)
            # Single-process demo policy: a second instance cannot fail the first one's work.
            ownership = psycopg.connect(
                settings.database_url,
                autocommit=True,
                connect_timeout=5,
                options="-c statement_timeout=5000",
            )
            if not ownership.execute("SELECT pg_try_advisory_lock(%s)", (SERVICE_LOCK,)).fetchone()[
                0
            ]:
                raise RuntimeError(
                    "Another fund-service instance owns this database; use one worker process."
                )
            repository = Repository(pool, settings.queue_capacity)
            repository.interrupt_unfinished()
            if settings.seed_demo:
                seed(repository, settings.source_dir)
            app.state.repository = repository
            if run_worker:
                worker = Worker(repository, settings.source_dir, ownership)
                worker.start()
            app.state.worker = worker
            yield
        finally:
            if worker:
                worker.close()
            if ownership:
                ownership.close()
            pool.close()

    app = FastAPI(
        title="Private fund reconciliation service",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def context(request: Request, call_next):
        candidate = request.headers.get("x-request-id", "")
        request.state.request_id = (
            candidate if re.fullmatch(r"[\w-]{1,128}", candidate) else str(uuid4())
        )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        log.info(
            "request id=%s method=%s path=%s status=%s",
            request.state.request_id,
            request.method,
            request.url.path,
            response.status_code,
        )
        return response

    def error_response(request, status, code, message, details=None):
        error = {"code": code, "message": message, "request_id": request.state.request_id}
        if details:
            error["details"] = details
        return JSONResponse(
            status_code=status,
            content={"schema_version": 1, "error": error},
            headers={"X-Request-ID": request.state.request_id},
        )

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return error_response(request, error.status, error.code, error.message, error.details)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, _error):
        return error_response(
            request, 422, "INVALID_REQUEST", "The request does not match the service contract."
        )

    @app.exception_handler(SourceFailure)
    async def source_error(request, error):
        return error_response(request, 409, error.code, error.message)

    @app.exception_handler(Exception)
    async def unexpected(request, error):
        log.exception("Request failed id=%s", request.state.request_id, exc_info=error)
        unavailable = isinstance(error, (psycopg.OperationalError, PoolTimeout))
        return error_response(
            request,
            503 if unavailable else 500,
            "SERVICE_UNAVAILABLE" if unavailable else "INTERNAL_ERROR",
            "The fund service could not complete this request.",
        )

    def principal(request: Request):
        expected = f"Bearer {settings.service_token}"
        if not hmac.compare_digest(
            request.headers.get("authorization", "").encode(), expected.encode()
        ):
            raise ServiceError(
                401, "INVALID_SERVICE_IDENTITY", "A valid service credential is required."
            )
        try:
            actor = request.headers["x-actor-id"]
            grants = json.loads(request.headers["x-allowed-fund-ids"])
            can_run = request.headers["x-can-run"]
            if (
                not re.fullmatch(r"[\w-]{1,128}", actor)
                or not isinstance(grants, list)
                or len(grants) > 1000
                or can_run not in {"true", "false"}
            ):
                raise ValueError()
            return {
                "id": actor,
                "fund_ids": [str(UUID(value)) for value in grants],
                "can_run": can_run == "true",
            }
        except (KeyError, ValueError, TypeError, AttributeError):
            raise ServiceError(
                422, "INVALID_SERVICE_CONTEXT", "The trusted actor scope is missing or invalid."
            ) from None

    actor_dependency = Depends(principal)

    @app.get("/healthz")
    def health(request: Request):
        with request.app.state.repository.pool.connection() as conn:
            conn.execute("SELECT 1")
        if request.app.state.worker and not request.app.state.worker.thread.is_alive():
            raise ServiceError(
                503, "WORKER_UNAVAILABLE", "The reconciliation worker is unavailable."
            )
        return {"status": "ok"}

    @app.get("/internal/v1/funds")
    def funds(
        request: Request,
        period_start: date | None = None,
        period_end: date | None = None,
        actor=actor_dependency,
    ):
        if (
            set(request.query_params) - {"period_start", "period_end"}
            or bool(period_start) != bool(period_end)
            or (period_start and period_start > period_end)
        ):
            raise ServiceError(
                422, "INVALID_PERIOD", "Supply both reporting dates in chronological order."
            )
        return request.app.state.repository.list(
            actor, period_start or date(2026, 4, 1), period_end or date(2026, 6, 30)
        )

    @app.post("/internal/v1/funds/{fund_id}/runs")
    def start(fund_id: UUID, body: StartRun, request: Request, actor=actor_dependency):
        if request.app.state.worker and not request.app.state.worker.thread.is_alive():
            raise ServiceError(
                503, "WORKER_UNAVAILABLE", "Restart the fund service before starting new runs."
            )
        key = request.headers.get("idempotency-key", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key):
            raise ServiceError(400, "INVALID_REQUEST", "A valid Idempotency-Key is required.")
        run = request.app.state.repository.start(
            actor, str(fund_id), str(body.reconciliation_period_id), key, request.state.request_id
        )
        return JSONResponse(
            status_code=202 if run["state"] in {"queued", "running"} else 200,
            content=run,
            headers={"Location": run["poll_url"]},
        )

    @app.get("/internal/v1/runs/{run_id}")
    def run(run_id: UUID, request: Request, actor=actor_dependency):
        return request.app.state.repository.get(actor, str(run_id))

    @app.get("/internal/v1/runs/{run_id}/sources/{document_id}")
    def source(run_id: UUID, document_id: UUID, request: Request, actor=actor_dependency):
        row = request.app.state.repository.snapshot(actor, str(run_id))
        allowed = row["state"] == "completed" and any(
            s["document_id"] == str(document_id) for s in row["result"]["sources"]
        )
        document = next(
            (d for d in row["input_snapshot"]["documents"] if d["document_id"] == str(document_id)),
            None,
        )
        if not allowed or not document:
            raise ServiceError(
                404, "RESOURCE_NOT_FOUND", "This document is not cited by this completed run."
            )
        return Response(
            read(settings.source_dir, document),
            media_type=document["media_type"],
            headers={"Content-Disposition": f'attachment; filename="{document["filename"]}"'},
        )

    return app
