# Fund service

Python/FastAPI owns reconciliation, Postgres records and original source files. Express supplies authenticated demo actor/fund scope and calls the four private operations; React continues to use the existing public routes.

## Start and stop

From the repository root, with Docker running:

```sh
npm ci
npm run dev:service
```

This generates local credentials in ignored `.env` if needed, builds the service with its locked Python dependencies, starts Postgres 17 and FastAPI, then starts Express and React. Open http://127.0.0.1:3700. Only loopback ports are published: 3700 (web), 4700 (Express), 4701 (FastAPI), 5433 (Postgres).

Use Ctrl+C for Node/Vite, then `npm run services:stop` for the containers. Named volumes retain Postgres data and original source bytes. `npm run services:up` starts just the dependencies. `docker compose logs fund-service` shows request/run IDs for tracing.

For local Python development, install `uv`. Copy the registered source bytes from the Docker volume before sharing its database, then stop only the containerised fund service:

```sh
uv sync --project fund-service
mkdir -p fund-service/data
docker compose cp fund-service:/data/sources/. fund-service/data/
docker compose stop fund-service
```

Run from `fund-service/` (Postgres stays running):

```sh
uv run --env-file ../.env uvicorn fund_service.app:create_app --factory --host 127.0.0.1 --port 4701
```

Local Python uses `fund-service/data/`, while Docker uses a named source volume. Keep the corresponding source bytes with the database when moving between environments. Do not run two service processes against the same database: an advisory lock intentionally rejects the second instance. After a database outage breaks service ownership, restart the fund service; health and new-run admission fail closed until then. This is a single-worker demo, not a distributed job system.

## Supported input

`fixtures/manifest.json` names six fictional Q2 2026 packs. The importer registers those files once, copying their exact bytes into content-addressed storage and retaining SHA-256, length, filename and document role in Postgres. It never replaces an existing pack with different contents. A new layout/pack needs an explicit new version and importer extension; there is no public upload API yet.

CSV v1 is UTF-8 (an optional BOM is accepted) with exactly this header:

```csv
fund,period_start,period_end,currency,scale,field,value
```

- `fund` must exactly match the registered whole-fund name; dates and currency must match the reporting period.
- Currency: USD, EUR or GBP. Scale: `1`, `1000` or `1000000`.
- Opening document: `opening_nav`; activity: `capital_calls`, `distributions`; statement: `net_income`, `reported_nav`.
- One selected value per field. Missing, duplicate/conflicting, invalid-scope or unsupported-layout values block a numerical conclusion. Missing is never zero.
- Amounts permit standard decimal text, correctly grouped commas and accounting brackets. Calls/distributions become non-negative magnitudes, while income/loss stays signed. A bracketed distribution is converted once to a positive magnitude and subtracted once by the rule. Unmapped negative movement conventions require input.
- Original strings, scale and one-based CSV data-record/column locators are kept with each selected fact. Record numbers exclude the header and account for quoted multiline fields.
- Files over 2 MB or more than 10,000 records need another supported layout/limit policy. PDFs require the optional agent mode below; Excel extraction is deferred.

The rule is `opening + calls - distributions + signed income`. A match requires input alignment and an unrounded absolute difference no greater than `0.010000` in the fund currency. Python Decimal uses a 50-digit arithmetic context; values are checked for finite range and six-place precision before `NUMERIC(38,6)` insertion. API money is always a decimal string.

Summit's statement deliberately contains invalid UTF-8 bytes. Its technical failure comes from reading that file; outcomes are not hardcoded by fund ID. Unsupported but readable layouts produce `insufficient_evidence` instead.

## State, storage and execution

`migrations/001_initial.sql` creates typed fund/period/pack/document/run/fact/check/idempotency tables, foreign keys, exact numeric columns and a unique index allowing one active run per period. A small migration runner records file hashes and rejects edits to an already applied migration. Add a new migration for subsequent schema changes.

Run admission uses short Postgres transactions, a transaction advisory lock and a period row lock. It checks access, replays existing matching idempotency keys, checks pack readiness/active runs/capacity, then commits a queued row and idempotency record together. At most eight runs may be queued/running (`FUND_QUEUE_CAPACITY`). A full queue returns `503` without consuming the key. The database queue avoids a separate commit-versus-enqueue crash window.

One worker claims queued records, commits `running`, then parses files outside a transaction. It persists stage changes and publishes facts, checks, deterministic commentary and the completed decision atomically. Checks and canonical facts have typed numeric columns; the immutable public decision is also retained as JSONB for exact historical reads. Status polling does not drive execution, and there is no artificial processing delay.

Each run freezes its fund/period/pack/rules, document hashes/roles and parser version. Source reads recheck fund access, membership in that completed run, byte length and SHA-256. A missing or altered file produces an error, never a replacement snippet. Historical financial decisions stay unchanged.

Completed decisions and idempotency records survive restarts. On startup, after acquiring exclusive service ownership, unfinished runs are marked `failed / PROCESS_INTERRUPTED`. Replaying their original key returns that failed run; a new intentional retry needs a new key. No automatic job retry, cancellation, review actions or retention expiry is implemented.

## Private API and shared contracts

The four `/internal/v1` operations mirror [the public API](../docs/plans/api-contracts.md). Each requires the private bearer service token plus `X-Actor-ID`, JSON `X-Allowed-Fund-IDs`, `X-Can-Run` and a request ID supplied by Express. Demo user tokens are not service credentials. `/healthz` is an internal operational probe, not an extra public business route.

Python validates response shapes using `packages/contracts/wire.schema.json`, generated from the TypeScript Zod schemas with `npm run contracts:generate`. A TypeScript test detects schema drift. Pydantic validates incoming commands, rejecting unknown fields. Internal schemas, service errors and public routes are exercised through the real database tests and the Express HTTP adapter tests.

## Tests

```sh
npm run services:up
npm run test:fund
uv run --project fund-service ruff check fund-service
NAV_E2E_MODE=service PLAYWRIGHT_CHROME_CHANNEL=chrome npm run test:e2e
```

`test:fund` uses local `uv` and the database address from `.env`. Each integration test creates its own randomly named database and source directory, then removes only those test resources. It never truncates the demo database. Tests cover source extraction, precision, tolerance boundaries, permissions, concurrent idempotency, capacity, transactional rollback, provenance, file tampering and service restart behaviour.

Production identity, multiple workers, durable automatic recovery, upload workflows, general layout support, candidate review, image-only scans, Excel and ranged reads remain later work. Optional whole-file agent assistance for known CSV/PDF layouts is implemented below.

## Optional agent mode

The existing worker can use Pydantic AI and OpenAI with `AGENT_MODE=assist`; default `off` runs only deterministic extraction. Configure `OPENAI_API_KEY` in the root `.env` and `SEED_AGENT_DEMO=true` to register Harbor Infrastructure III. Rebuild/recreate with `npm run docker:up`. The key is passed only to this service. New runs freeze their non-secret policy; startup never creates paid model runs.

Tools are limited to listing and reading complete authorised CSV/PDF files. Full-page PDF images support a blinded visual verification call. Python validates citations, performs exact Decimal calculations and renders constrained commentary. Ranged reads are a non-registered placeholder. The implementation supports the known demo layouts and returns Needs input for unsupported mappings.

See [agent implementation](../docs/plans/agent-implementation.md) for configuration, limits, audit storage, offline tests and the explicit paid evaluation command.
