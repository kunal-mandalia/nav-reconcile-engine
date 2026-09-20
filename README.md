# NAV reconciliation demo

A TypeScript React app connected to an Express API, using a mocked fund service to explore the agreed four-endpoint workflow. The UI follows the [UX proposal](docs/proposals/nav-reconciliation-ux.html).

## Run locally

Requires Node.js 22.12+ (tested with Node 24) and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Express listens on **http://127.0.0.1:4000**; Vite proxies `/api` to it. Both bind to loopback. No database, Python setup or environment file is needed for this slice. Stop with Ctrl+C; restarting the API resets all demo runs and idempotency records.

## Try the flow

1. Open **Atlas Growth Fund IV** to see the positive NAV mismatch, the calculation and next action.
2. Follow a numbered citation to the original/normalised value and exact CSV location. Download the source to verify it.
3. **Rerun → Start run** creates a new run, shows progress and polls until its decision appears. The same pack produces the same outcome; older run URLs retain their decisions for the server session.
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
| `web-server/` | Express, TypeScript. Demo identity, permissions, rate limits, request validation/IDs, errors and mock service adapter. |
| `packages/contracts/` | Shared Zod runtime schemas and inferred TypeScript DTOs; both ends validate responses. |
| `fund-service/` | Placeholder for the planned Python/FastAPI service. |

The planned stack remains **React → Express → FastAPI → Postgres + source files**. The mock implements the `FundService` adapter inside Express; later an HTTP adapter will call the private Python service without changing the four public routes or React API client. Service authentication, trusted scope/request-ID forwarding, downstream timeouts, Python extraction and Postgres migrations are not implemented yet.

The mock constructs original CSV bytes and cited facts from the same fixed fixture records. It performs real decimal addition/subtraction against those values, but simulates extraction and processing stages. Decisions, source bytes and idempotency records live in memory. No uploads, real file parsing, database, durable worker, AI, editable mappings or review commands are included. Human approval remains separate from a mathematical match.

Money travels as six-place decimal strings. Mock calculations use `decimal.js` with 50-digit precision and reject overflow or excess scale. The UI uses decimal formatting without converting amounts through JavaScript `Number`. The planned service uses Python `Decimal` and Postgres `NUMERIC(38,6)`, validating before insertion.

## API and demo controls

The [API contract](docs/plans/api-contracts.md) describes exactly four operations under `/api/v1`:

| Operation | Response |
| --- | --- |
| `GET /funds` | Authorised fund summaries for the selected period |
| `POST /funds/:fundId/runs` | Start/replay a run; strict `{ "reconciliation_period_id": "…" }` body and `Idempotency-Key` header |
| `GET /runs/:runId` | Execution state, then complete decision, facts, checks, commentary and sources |
| `GET /runs/:runId/sources/:documentId` | Original cited CSV bytes after fund and source-membership checks |

Every operation requires `Authorization: Bearer demo-operations` or `Authorization: Bearer demo-reviewer`. These are deliberately public demo tokens, **not production authentication**. The executable requires `--mock` (included in npm scripts) and refuses `NODE_ENV=production`.

Alex has read/run access to all six funds; Priya can read Meridian and Cove. Rate budgets default to 180 reads and 6 run requests per minute per identity. Throttled requests return `429` with `Retry-After`. Errors include a request ID. Polling and run creation have separate budgets. The browser keeps an idempotency key in session storage until a definitive response, so retrying a lost POST response reuses the original run.

```sh
curl -H 'Authorization: Bearer demo-operations' \
  http://127.0.0.1:4000/api/v1/funds

curl -X POST -H 'Authorization: Bearer demo-operations' \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: walkthrough-001' \
  -d '{"reconciliation_period_id":"00000000-0000-4000-8000-000000000101"}' \
  http://127.0.0.1:4000/api/v1/funds/00000000-0000-4000-8000-000000000001/runs
```

The POST returns `202` while active, or `200` when replaying a terminal run. Follow its `Location`/`poll_url`. Each simulated stage lasts one second; a run completes after five seconds, materialised on the next API read. An intentional rerun uses a new key. A new key while a run is active returns `409` and its run ID.

Optional shell environment variables for the API: `PORT` (4000), `MOCK_STAGE_MS` (1000), `READ_RATE_LIMIT` (180), `RUN_RATE_LIMIT` (6). If changing `PORT`, also change the Vite proxy target. For example, `RUN_RATE_LIMIT=1 npm run dev` makes throttling easy to demonstrate.

## Verification

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

With Google Chrome already installed, use `PLAYWRIGHT_CHROME_CHANNEL=chrome npm run test:e2e` instead of installing Chromium. Playwright starts the app and API if needed; use a fresh default mock server for repeatable seeded scenarios.

Unit/API checks cover permission boundaries, request validation, idempotency, active-run conflicts, immutable earlier decisions, source locators/bytes, rate budgets, missing-vs-zero amounts and monetary precision/tolerance. Browser checks cover drilldown/downloads, reruns/polling, lost POST responses, first runs, missing inputs, failed runs, read-only access, empty/search views, network recovery and mobile layout.

`npm run build` writes `web-server/dist` and `web-app/dist`. `npm run start -w web-server` runs the built API in explicit mock mode; the build is not a production-authenticated deployment.
