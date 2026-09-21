import hashlib

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import ROOT

# Separate locks for schema changes, service ownership and short run-admission transactions.
MIGRATION_LOCK, SERVICE_LOCK, ADMISSION_LOCK = 781400, 781401, 781402


def open_pool(database_url: str):
    pool = ConnectionPool(
        database_url,
        min_size=1,
        max_size=8,
        open=False,
        timeout=5,
        kwargs={
            "row_factory": dict_row,
            "options": "-c statement_timeout=10000 -c lock_timeout=5000",
        },
    )
    pool.open(wait=True, timeout=15)
    return pool


def migrate(pool):
    with pool.connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)"
        )
        for path in sorted((ROOT / "migrations").glob("*.sql")):
            sql = path.read_text()
            digest = hashlib.sha256(sql.encode()).hexdigest()
            applied = conn.execute(
                "SELECT sha256 FROM schema_migration WHERE name = %s", (path.name,)
            ).fetchone()
            if applied:
                if applied["sha256"] != digest:
                    raise RuntimeError(f"Applied migration changed: {path.name}")
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO schema_migration VALUES (%s,%s)", (path.name, digest))
