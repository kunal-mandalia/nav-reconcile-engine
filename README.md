# NAV reconciliation demo

A React/TypeScript app and Express API connected to a Python/FastAPI reconciliation service, Postgres and immutable source files. An in-memory mock mode is also available. Both use the same four public operations. The UI follows the [UX proposal](docs/proposals/nav-reconciliation-ux.html).

## Run everything in Docker

```sh
npm run docker:up
```

Open **http://127.0.0.1:3005**. This builds the frontend (served by Nginx), the Express client API and FastAPI, and starts Postgres. It creates an ignored `.env` with local credentials if absent. Requires Node.js 22.12+ and Docker Compose; host npm dependencies and Python are not needed for this path.

Set the client API adapter in the root `.env`:

```dotenv
CLIENT_API_BACKEND=fund-service
```

Use `mock` for the in-memory adapter or `fund-service` for FastAPI/Postgres (default). Apply a change by running `npm run docker:up` again, then refresh the browser. The frontend image is identical in either mode; the response-driven badge confirms the selected adapter. Startup prints the effective mode.

For a one-command override, without editing `.env`:

```sh
CLIENT_API_BACKEND=mock npm run docker:up
CLIENT_API_BACKEND=fund-service npm run docker:up
```

Shell settings override `.env`. The wrapper starts FastAPI/Postgres and waits for them before starting the web containers in service mode. In mock mode it starts only the web containers and stops any existing FastAPI/Postgres containers, preserving their named volumes. Mock state resets when Express restarts; changing back to the fund service restores its persistent run history. Switching modes changes the run set, so refresh any open tab; old mock run URLs may no longer exist.

`npm run docker:stop` stops all four containers without deleting data. Use the wrapper for mode-aware startup; plain `docker compose up` starts all four services regardless of the adapter setting. `docker compose restart` does not apply edited environment variables: use `npm run docker:up` to recreate containers as needed.

Nginx proxies `/api` to Express using the Compose service name; Express calls `http://fund-service:8000`. The browser sees one origin. Nginx re-resolves the API address after container replacement. See [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/). No service credential is bundled into the frontend. The Express container keeps `NODE_ENV=development` because this is still the demo-identity API, even though it runs compiled JavaScript.

## Optional agent workflow

Set `AGENT_MODE=assist`, `OPENAI_API_KEY`, and `SEED_AGENT_DEMO=true` in the root `.env`, with `CLIENT_API_BACKEND=fund-service`, then run `npm run docker:up`. Start **Harbor Infrastructure III** to process its fictional CSV/PDF pack with whole-file read tools and independent visual verification. The fund list shows the mode for new runs; run context shows actual model usage and verification.

`AGENT_MODE=off` keeps deterministic-only processing (the default). The original six CSV packs continue to work; the Harbor layout returns Needs input in deterministic mode. Existing runs retain their original mode. Ranged reads are an explicit future extension. See [implementation, limits and tests](docs/plans/agent-implementation.md).

## Develop locally with hot reload

Stop Docker web containers first (`npm run docker:stop`) to free ports 3005 and 4000.

Requires Node.js 22.12+ (tested with Node 24), npm and a running Docker engine. Python dependencies are installed in the service container; local `uv` is only needed for Python development/tests.

```sh
npm ci
npm run dev:service
```

Open **http://127.0.0.1:3005**. The startup command creates a git-ignored `.env` with generated local credentials, builds FastAPI, starts Postgres, applies migrations and registers the sample packs once. Existing credentials and data are preserved.

| Process | Address | Storage |
| --- | --- | --- |
| React/Vite | `127.0.0.1:3005` | Browser cache and demo identity |
| Express | `127.0.0.1:4000` | In-memory demo rate limits |
| FastAPI + one worker | `127.0.0.1:8000` | Private service API; original files in a Docker volume |
| Postgres 17 | `127.0.0.1:5433` | Named Docker volume for funds, packs, runs, facts, checks and idempotency |

The web app calls only Express. FastAPI requires a service credential and trusted fund/action scope from Express. All published development ports bind to loopback.

Stop the web app/API with **Ctrl+C**, then `npm run services:stop` for FastAPI and Postgres. Container stop/restart and `docker compose down` preserve the named volumes. Completed runs, original sources and idempotency records survive restarts. Unfinished runs become `failed / PROCESS_INTERRUPTED` when the fund service starts again.

For the original lightweight UX mock, run `npm run dev` instead. It needs no Docker or `.env` and still resets its server state on restart. Choose one frontend/API mode at a time; the banner identifies which is running.

## Try the flow

1. Open **Atlas Growth Fund IV** to see the positive NAV mismatch, the calculation and next action.
2. Follow a numbered citation to the original/normalised value and exact CSV location. Download the source to verify it.
3. **Rerun → Start run** creates a new run, shows progress and polls until its decision appears. The same pack produces the same outcome; older run URLs retain their decisions across restarts in service mode.
4. Open **Oakbridge** for missing income, **Summit** for a technical failure, or start **Northline** to see a negative variance. Missing amounts stay unknown, never zero.
5. Switch the demo identity to **Priya Shah**: only two authorised funds appear and reruns are disabled. Direct API requests enforce the same permissions.

| Fund | Seeded state | Purpose |
| --- | --- | --- |
| Atlas Growth Fund IV | NAV mismatch, USD +250,000 | Positive variance, commentary and citations |
| Meridian Infrastructure II | Matched | Passing checks |
| Oakbridge Private Credit | Needs input | Missing net income; no calculated NAV |
| Cove Real Estate Partners | Matched | Second read-only-accessible fund |
| Northline Ventures III | Not run | Start first run; USD −85,000 variance with signed loss |
| Summit Secondaries I | Run failed | Safe processing error, separate from financial outcome |

All fixtures use Q2 2026, whole-fund scope, and an absolute tolerance of **0.01 in the fund currency**. Q1 demonstrates the empty-period view. Search and status filters operate on the authorised list.

## Code boundaries

| Directory | Current implementation |
| --- | --- |
| `web-app/` | React, Vite, React Query, TypeScript. API-driven list, decision, evidence, download, polling and rerun flows. |
| `web-server/` | Express, TypeScript. Demo identity, permissions, rate limits, request validation/IDs, errors, and mock/remote service adapters. |
| `packages/contracts/` | Zod runtime schemas, inferred TypeScript DTOs and generated JSON Schema consumed by Python. |
| `fund-service/` | FastAPI, Psycopg, SQL migration, fixed-layout CSV parser, Decimal rules, background worker and source storage. |

The implemented service path is **React → Express → FastAPI → Postgres + source files**. Express supplies a private service credential, derives fund/action scope from the demo identity, forwards request IDs and maps downstream errors/timeouts. It never reads Postgres or source storage directly.

Python parses the checked-in fictional CSV packs, records exact record/column locators, validates period/fund/currency/scale and calculates the whole-fund capital roll-forward. Missing, conflicting or unsupported inputs produce `insufficient_evidence`; unreadable source bytes produce a technical failure. Summit's fixture deliberately contains invalid UTF-8 to demonstrate that distinction. No outcome is hardcoded in the Python worker.

Runs freeze the pack manifest, hashes, rules and source metadata at admission. A short transaction records a new run and idempotency record; one worker processes the bounded database queue without holding a transaction during file parsing. Facts, checks, commentary and the completed decision publish together. Sources are stored by SHA-256 and verified again before parsing or download.

Money travels as six-place decimal strings. Python uses `Decimal` with 50-digit calculation precision and validates values before Postgres `NUMERIC(38,6)` insertion. The mock uses `decimal.js`; the UI formats decimals without converting through JavaScript `Number`.

This remains a local demo: production login, uploads, general PDF/Excel layout support, editable mappings, human review commands, ranged reads and automatic interrupted-job recovery are deferred. Optional agent assistance supports the known CSV/PDF demo layouts. The supported input layout and operational details are in [fund-service/README.md](fund-service/README.md).

## API and demo controls

The [API contract](docs/plans/api-contracts.md) describes exactly four operations under `/api/v1`:

| Operation | Response |
| --- | --- |
| `GET /funds` | Authorised fund summaries for the selected period |
| `POST /funds/:fundId/runs` | Start/replay a run; strict `{ "reconciliation_period_id": "…" }` body and `Idempotency-Key` header |
| `GET /runs/:runId` | Execution state, then complete decision, facts, checks, commentary and sources |
| `GET /runs/:runId/sources/:documentId` | Original cited CSV bytes after fund and source-membership checks |

Every operation requires `Authorization: Bearer demo-operations` or `Authorization: Bearer demo-reviewer`. These are deliberately public demo tokens, **not production authentication**. The executable accepts `CLIENT_API_BACKEND=mock|fund-service` or explicit `--mock` / `--service` flags and refuses `NODE_ENV=production`. Explicit flags take precedence over the environment; the existing development scripts retain their named modes. Invalid or missing configuration fails startup instead of silently selecting mock data.

Alex has read/run access to the six original funds and optional Harbor sample; Priya can read Meridian and Cove. Rate budgets default to 180 reads and 6 run requests per minute per identity. Throttled requests return `429` with `Retry-After`. Errors include a request ID. Polling and run creation have separate budgets. The browser keeps an idempotency key in session storage until a definitive response, so retrying a lost POST response reuses the original run.

```sh
curl -H 'Authorization: Bearer demo-operations' \
  http://127.0.0.1:4000/api/v1/funds

curl -X POST -H 'Authorization: Bearer demo-operations' \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: walkthrough-001' \
  -d '{"reconciliation_period_id":"00000000-0000-4000-8000-000000000101"}' \
  http://127.0.0.1:4000/api/v1/funds/00000000-0000-4000-8000-000000000001/runs
```

The POST returns `202` while active, or `200` when replaying a terminal run. Follow its `Location`/`poll_url`. Service-mode work runs independently of status reads and usually completes quickly for these small packs. Mock mode simulates five one-second stages. An intentional rerun uses a new key. A new key while a run is active returns `409` and its run ID.

Service configuration in `.env`: `FUND_SERVICE_URL`, `FUND_SERVICE_TOKEN` and `DATABASE_URL` (for local Python tools). Compose supplies its own internal database address. Express uses a 10-second downstream timeout (`FUND_SERVICE_TIMEOUT_MS`). The service allows eight outstanding runs by default (`FUND_QUEUE_CAPACITY`); run one service process.

Optional shell environment variables for the API: `HOST` (127.0.0.1 locally, 0.0.0.0 inside Docker), `PORT` (4000), `MOCK_STAGE_MS` (1000), `READ_RATE_LIMIT` (180), `RUN_RATE_LIMIT` (6). If changing `PORT`, also change the Vite proxy target. For example, `RUN_RATE_LIMIT=1 npm run dev` makes throttling easy to demonstrate.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run services:up
npm run test:fund
npx playwright install chromium
npm run test:e2e
NAV_E2E_MODE=service npm run test:e2e
```

With Google Chrome already installed, use `PLAYWRIGHT_CHROME_CHANNEL=chrome npm run test:e2e` instead of installing Chromium. Playwright starts the matching app/API mode if needed. Stop any existing app/API before switching test modes; use a fresh default mock for the mock scenarios. Persistent-mode tests rerun a fund without resetting its history. Python integration tests create and remove randomly named test databases; they never clear the demo database.

Unit/API checks cover permission boundaries, request validation, idempotency, active-run conflicts, immutable earlier decisions, source locators/bytes, rate budgets, missing-vs-zero amounts and monetary precision/tolerance. Browser checks cover drilldown/downloads, reruns/polling, lost POST responses, first runs, missing inputs, failed runs, read-only access, empty/search views, network recovery and mobile layout.

Run `npm run contracts:generate` after changing the TypeScript schemas; a test detects a stale Python schema snapshot. Python checks: `uv run --project fund-service ruff check fund-service`.

`npm run build` writes `web-server/dist` and `web-app/dist`. `npm run start -w web-server` runs the built API in explicit mock mode; `npm run start:service -w web-server` connects the built API to FastAPI. The frontend build is identical in both modes; it learns the data source from Express responses. Neither mode includes production login.

The header’s data-source badge is confirmed by API responses: **Mock · temporary data** or **Fund service · persisted data**. A failed request marks the connection disconnected and identifies any retained results as cached; a successful retry restores the badge. Both modes use fictional sample packs. This reports the last observed connection, not a continuous health check.
