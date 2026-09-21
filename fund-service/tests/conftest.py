import os
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from fund_service.app import create_app
from fund_service.config import Settings

TOKEN = "test-service-token-not-a-secret-123456789"


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def headers(*, funds=None, can_run=True, actor="alex-chen", key=None):
    import json

    value = {
        "Authorization": f"Bearer {TOKEN}",
        "X-Actor-ID": actor,
        "X-Allowed-Fund-IDs": json.dumps(funds or [uid(n) for n in range(1, 7)]),
        "X-Can-Run": str(can_run).lower(),
        "X-Request-ID": "test-request-123",
    }
    if key:
        value["Idempotency-Key"] = key
    return value


@pytest.fixture
def settings(tmp_path):
    admin_url = os.environ.get("TEST_DATABASE_URL")
    if not admin_url:
        pytest.skip("Run npm run test:fund to exercise a real, isolated Postgres database")
    name = f"nav_test_{uuid4().hex}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        yield Settings(make_conninfo(admin_url, dbname=name), TOKEN, tmp_path / "sources")
    finally:
        # Only the random database created by this fixture is removed; demo data is untouched.
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings, run_worker=False)) as instance:
        yield instance
