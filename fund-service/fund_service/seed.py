import json

from .config import ROOT
from .sources import digest, store
from .worker import process


def seed(repository, source_dir, fixture_dir=ROOT / "fixtures"):
    """Register immutable fixture packs once; subsequent starts preserve all persisted state."""
    manifest = json.loads((fixture_dir / "manifest.json").read_text())
    created = []
    with repository.pool.connection() as conn:
        for item in manifest["funds"]:
            fund = item["fund"]
            documents = []
            for document in item["documents"]:
                data = (fixture_dir / fund["fund_id"] / document["filename"]).read_bytes()
                documents.append(
                    {**document, "sha256": digest(data), "byte_size": len(data), "data": data}
                )
            pack_hash = digest(
                json.dumps(
                    [{k: v for k, v in d.items() if k != "data"} for d in documents], sort_keys=True
                ).encode()
            )
            existing = conn.execute(
                "SELECT manifest_sha256 FROM pack WHERE id=%s", (item["pack_id"],)
            ).fetchone()
            if existing:
                if existing["manifest_sha256"] != pack_hash:
                    raise RuntimeError(
                        "An existing seed pack changed. Register a new pack version instead of replacing history."
                    )
                continue
            conn.execute(
                "INSERT INTO fund (id,name,administrator,strategy,currency) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (
                    fund["fund_id"],
                    fund["name"],
                    fund["administrator"],
                    fund["strategy"],
                    item["currency"],
                ),
            )
            conn.execute(
                """INSERT INTO reconciliation_period (id,fund_id,period_start,period_end,entity_scope,currency,ruleset_version,tolerance)
                VALUES (%s,%s,%s,%s,'fund',%s,'capital-roll-forward-v1',0.01) ON CONFLICT DO NOTHING""",
                (
                    item["reconciliation_period_id"],
                    fund["fund_id"],
                    manifest["period"]["start"],
                    manifest["period"]["end"],
                    item["currency"],
                ),
            )
            conn.execute(
                "INSERT INTO pack (id,reconciliation_period_id,version,state,manifest_sha256) VALUES (%s,%s,%s,'ready',%s)",
                (
                    item["pack_id"],
                    item["reconciliation_period_id"],
                    item["pack_version"],
                    pack_hash,
                ),
            )
            for document in documents:
                key = store(source_dir, document["data"])
                conn.execute(
                    """INSERT INTO document (id,pack_id,filename,storage_key,sha256,byte_size,media_type,role)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        document["document_id"],
                        item["pack_id"],
                        document["filename"],
                        key,
                        document["sha256"],
                        document["byte_size"],
                        document["media_type"],
                        document["role"],
                    ),
                )
            conn.execute(
                "UPDATE reconciliation_period SET current_pack_id=%s WHERE id=%s",
                (item["pack_id"], item["reconciliation_period_id"]),
            )
            created.append(item)
    actor = {
        "id": "demo-seed",
        "fund_ids": [f["fund"]["fund_id"] for f in created],
        "can_run": True,
    }
    for item in created:
        if item["initial_run"]:
            repository.start(
                actor,
                item["fund"]["fund_id"],
                item["reconciliation_period_id"],
                f"seed-{item['pack_id']}",
                "demo-seed",
                seed_run=True,
            )
            row = repository.claim()
            if row:
                process(repository, row, source_dir)
