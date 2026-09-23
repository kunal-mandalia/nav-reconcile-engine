# API contracts — compact demo

These four endpoints are implemented in Express, backed by either the in-memory mock or the Python/FastAPI service with Postgres, and consumed by the React app. The shared [Zod schemas and inferred TypeScript types](../../packages/contracts/src/index.ts) define the executable contract. Python validates against JSON Schema generated from the same TypeScript contract. The first demo exposes **four public endpoints** covering the requested fund list, status, rerun and decision/source drilldown. The [state and data design](state-and-data.md) preserves the domain model without exposing every entity as a resource API.

## 1. Demo scope and conventions

Seed funds, reconciliation periods, complete document packs and rules locally. The current mock simulates extraction using generated CSV fixtures and performs deterministic decimal arithmetic. Service mode parses the checked-in fixed-layout CSV files and persists decisions and original sources. Keep input selection fixed while the demo runs. Upload, pack selection, rule editing, review commands and dedicated history routes are extensions, not prerequisites.

A `reconciliation_period` remains the internal grouping for a fund and reporting period. Return `reconciliation_period_id` where the UI needs it to start a run; there is no separate `/reconciliation-periods` endpoint. The UI label remains **Fund reconciliation**. Examples below are abbreviated design illustrations, including future PDF/spreadsheet locators; the runnable mock uses UUIDs and CSV locators. Use the shared schemas for the complete wire shape.

React calls `/api/v1` on Express. Express selects an in-memory or HTTP `FundService` adapter; Python exposes the corresponding four operations under `/internal/v1`. Express owns demo identity, fund permission checks, rate limits, validation and request IDs. Python owns reconciliation, persistence and idempotency. Private service credentials and trusted actor/fund context are never accepted directly from the browser.

For lists, Express forwards the caller's authorised fund IDs and Python filters before returning any rows or counts. For run/source access, Express forwards that allowlist as trusted scope; Python verifies resource ownership before returning data. Express defines user permissions; Python enforces resource membership against the supplied scope. This avoids a separate ownership-lookup endpoint. Rerun permission is checked by Express as well as the target fund's membership in the read/write scope.

Use decimal strings for money, UTC RFC 3339 event timestamps and date-only reporting boundaries. Null is unknown, not zero. JSON responses include `schema_version: 1`; binary source responses use their document media type. Return and propagate `X-Request-ID`; request IDs trace attempts, while idempotency keys identify one intended mutation. Reject unknown command fields.

Express sends `X-Data-Source: mock | fund-service` on responses, derived from its selected adapter. This metadata does not change the four endpoints or JSON schemas. The UI confirms the source only after a successful, validated response, never from the frontend build mode or an error response. Transport/server failures mark the connection unavailable and distinguish retained visible data from an initial load failure; cancellation and expected 4xx errors leave the last confirmation unchanged. A successful response without a recognised header displays “Data source unverified”. The badge describes the last observed connection, not a continuous health check. “Fictional sample packs” applies to both modes.

## Runtime selection

Docker runs the React build behind Nginx and the compiled Express client API. Set `CLIENT_API_BACKEND=mock|fund-service` in root `.env` and run `npm run docker:up` to apply it. Express owns this setting; the frontend has no separate mode flag. The startup wrapper runs only the two web containers in mock mode, or waits for FastAPI/Postgres before starting them in service mode. Both use the same four public routes and response schemas. Existing `--mock` and `--service` CLI flags override the environment for local development. Containers publish to loopback only; this remains a demo identity setup.

## Current mock details

- Local-only explicit mock mode: `npm run dev`; Express on `127.0.0.1:4000`, Vite on `127.0.0.1:3005` proxies `/api`. No extra public endpoints or browser-only fixtures.
- `Authorization: Bearer demo-operations` (all six funds, run permission), or `Bearer demo-reviewer` (Meridian and Cove, read only). These are public demonstration tokens, not secure login. The server executable refuses production mode.
- Read limit: 180 requests/minute per identity; run limit: 6/minute. Responses have `X-Request-ID`, `Cache-Control: no-store`; `429` includes `Retry-After` in seconds.
- Q2 2026 is seeded; an unseeded valid period returns an empty list. The fund shape also includes `strategy`, `last_run_at` and `status_reason`. `not_run` represents a ready pack with no attempt yet.
- Every run state includes `fund`, immutable `inputs`, `pack_id`, `created_at`, `stage_updated_at` and `poll_url`. This allows the UI to open active/failed runs directly without another fund-detail route. Completed responses add facts/checks/commentary/sources; failed responses have an error and no financial decision.
- Source entries include `media_type`. Current sources are generated CSV bytes; locators specify one-based data-record and column positions. The download is the same original fixture used to construct the cited fact, not a separately invented preview.
- Monetary strings have exactly six fractional digits. Demo tolerance is `0.010000` in each fund's currency. Precision must fit the `NUMERIC(38,6)` columns.
- The mock advances through five elapsed-time stages (one second each by default), materialised on the next API read. There is no actual extraction worker. Idempotency records and historical run/source snapshots last only until server restart; service mode stores these in Postgres and original sources in a named file volume.
- Mock HTTP errors cover validation, access, missing resources, active-run conflicts, idempotency conflicts and rate limits. Service mode also implements pack-not-ready checks, downstream timeouts and bounded queue admission.

## Persistent service mode

`npm run dev:service` starts the connected stack. FastAPI implements the four equivalent `/internal/v1` routes and a private operational `/healthz`; there is no additional public business endpoint. It accepts `Authorization: Bearer <FUND_SERVICE_TOKEN>`, `X-Actor-ID`, JSON `X-Allowed-Fund-IDs`, `X-Can-Run` and `X-Request-ID` supplied by Express. Browser-supplied scope/trace headers are replaced by trusted values. Service credentials never enter the frontend bundle.

Service idempotency records survive restarts. Admission serialises short transactions, rejects an active run for the period, and enforces an eight-run outstanding-work limit by default. A partial unique index also prevents duplicate active runs. A dedicated worker polls the database queue; status reads have no execution side effects. Real processing has no artificial delay. Results publish atomically and terminal runs remain unchanged. Unfinished runs become `PROCESS_INTERRUPTED` at restart; an intentional retry uses a new key. One service instance owns the database through an advisory lock.

The HTTP adapter applies a 10-second timeout, mapping connectivity failures to `503`, timeouts to `504`, invalid service credentials/shapes to `502`, and safe domain errors to their original status. Source reads verify both snapshot membership and SHA-256 before streaming original bytes. Missing/corrupt sources return an explicit error and never rewrite the historical financial result.

## 2. Four public endpoints

Paths below are relative to `/api/v1`.

| Endpoint | What the frontend gets or does |
| --- | --- |
| `GET /funds` | Authorised funds for the configured demo period, with NAV/status summaries, selected pack context and latest run IDs. Optional `period_start` and `period_end` must be supplied together to select another seeded period. |
| `POST /funds/{fund_id}/runs` | Start a reconciliation using a `reconciliation_period_id` in the body. Returns `202` and the new run ID; also serves the Rerun button. |
| `GET /runs/{run_id}` | Poll execution state; once completed, get calculation, checks, commentary, selected facts, source locations and source links in one response. |
| `GET /runs/{run_id}/sources/{document_id}` | Stream the original document cited by that run after checking fund permission and snapshot membership. |

Use local search/status filtering on the small authorised fund list. No server pagination or count endpoint is needed for the demo. The run response contains the small set of decision facts, not entire source spreadsheets. Historical runs remain readable by ID; a paginated history browser can be added later.

The run response powers Overview, Commentary and Sources views without separate endpoints per tab. PDFs can open in a browser at the cited page; spreadsheets can download, with the sheet/cell preview already present in the run facts. An interactive spreadsheet viewer is not required. Serve safe content headers, and never return local filesystem paths.

## 3. Fund list and rerun

One list response includes the context needed to render the fund row and start a run:

```json
{
  "schema_version": 1,
  "period": {"start": "2026-04-01", "end": "2026-06-30"},
  "funds": [
    {
      "fund_id": "fund-atlas",
      "name": "Atlas Growth Fund IV",
      "administrator": "Citco",
      "currency": "USD",
      "reconciliation_period_id": "period-atlas-2026q2",
      "pack": {"pack_id": "pack-atlas-v2", "version": 2, "state": "ready"},
      "display_status": "mismatch",
      "reported_nav": "128450000.000000",
      "difference": "250000.000000",
      "latest_run_id": "run-atlas-1042",
      "last_completed_run_id": "run-atlas-1042",
      "can_rerun": true
    }
  ]
}
```

`latest_run_id` points to the most recent attempt for the selected inputs, including an active or failed run. `last_completed_run_id` separately preserves the prior completed result. The row's NAV/difference summarise that completed result; while a newer run is active or failed, label these figures as the previous result. Both IDs and amounts can be null. `can_rerun` is UI guidance; the server rechecks permissions and readiness on every POST.

```http
POST /api/v1/funds/fund-atlas/runs
Content-Type: application/json
Idempotency-Key: atlas-q2-demo-attempt-01
```

```json
{"reconciliation_period_id": "period-atlas-2026q2"}
```

Identity comes from the configured demo authentication fixture. Python verifies that the period belongs to this fund, freezes its selected pack/rules, and prevents concurrent runs for the period. Clients do not send pack IDs, tolerance, actor identity, outcome or fact values. With fixed seeded selections there is no public revision precondition yet; add one when selection can change at runtime.

```json
{
  "schema_version": 1,
  "run_id": "run-atlas-1043",
  "reconciliation_period_id": "period-atlas-2026q2",
  "pack_id": "pack-atlas-v2",
  "state": "queued",
  "stage": "waiting",
  "outcome": null,
  "created_at": "2026-09-20T10:00:00Z",
  "poll_url": "/api/v1/runs/run-atlas-1043"
}
```

Return `202 Accepted` and a public `Location` polling URL after the run is recorded. Repeating the same key and request returns the same run (`202` while active, `200` when terminal). A different payload under the same key conflicts. An intentional rerun uses a new key; a timeout retry reuses the original key. No separate retry endpoint or retry-parent field is required.

Poll `GET /runs/{run_id}` approximately every two seconds while active; pause when hidden/offline, back off on throttling/transient errors, and stop on completion or failure. Refresh the fund list after completion. A failed poll is a connection problem, not proof the run failed. Status polling has a separate rate budget from expensive run creation.

## 4. One run response for the detail view

The illustrative example below embeds the selected facts and original-source links. There is no additional evidence lookup. During processing return run identity/state/stage with `outcome: null` and no final decision fields. On technical failure include a safe `error`; after completion return the immutable decision:

```json
{
  "schema_version": 1,
  "run_id": "run-atlas-1043",
  "reconciliation_period_id": "period-atlas-2026q2",
  "state": "completed",
  "stage": "finished",
  "outcome": "mismatch",
  "inputs": {
    "pack_id": "pack-atlas-v2",
    "pack_version": 2,
    "period_start": "2026-04-01",
    "period_end": "2026-06-30",
    "entity_scope": "fund",
    "currency": "USD",
    "ruleset_version": "capital-roll-forward-v1",
    "absolute_tolerance": "0.010000"
  },
  "summary": {
    "reported_nav": "128450000.000000",
    "calculated_nav": "128700000.000000",
    "difference": "250000.000000"
  },
  "checks": [
    {
      "check_id": "check-alignment",
      "type": "input_alignment",
      "required": true,
      "status": "pass",
      "reason_code": null,
      "input_fact_ids": ["fact-opening", "fact-calls", "fact-distributions", "fact-income", "fact-reported"]
    },
    {
      "check_id": "check-roll-forward",
      "type": "capital_roll_forward",
      "required": true,
      "status": "fail",
      "reason_code": "NAV_OUTSIDE_TOLERANCE",
      "expected_amount": "128700000.000000",
      "reported_amount": "128450000.000000",
      "difference_amount": "250000.000000",
      "tolerance_amount": "0.010000",
      "currency": "USD",
      "input_fact_ids": ["fact-opening", "fact-calls", "fact-distributions", "fact-income", "fact-reported"]
    }
  ],
  "facts": [
    {"fact_id": "fact-opening", "field": "opening_nav", "amount": "120000000.000000", "raw_text": "120,000,000.00", "currency": "USD", "scale": "1", "document_id": "doc-opening", "locator": {"kind": "spreadsheet", "sheet": "Opening balances", "range": "D8"}, "normalisation_steps": [{"operation": "parse_decimal"}]},
    {"fact_id": "fact-calls", "field": "capital_calls", "amount": "12000000.000000", "raw_text": "12,000,000.00", "currency": "USD", "scale": "1", "document_id": "doc-activity", "locator": {"kind": "spreadsheet", "sheet": "Q2 movements", "range": "F24"}, "normalisation_steps": [{"operation": "parse_decimal"}]},
    {"fact_id": "fact-distributions", "field": "distributions", "amount": "4000000.000000", "raw_text": "(4,000,000.00)", "currency": "USD", "scale": "1", "document_id": "doc-activity", "locator": {"kind": "spreadsheet", "sheet": "Q2 movements", "range": "F25"}, "normalisation_steps": [{"operation": "parse_accounting_number"}, {"operation": "distribution_outflow_to_magnitude"}]},
    {"fact_id": "fact-income", "field": "net_income", "amount": "700000.000000", "raw_text": "700,000.00", "currency": "USD", "scale": "1", "document_id": "doc-statement", "locator": {"kind": "pdf", "page_number": 4, "bbox": [40, 180, 560, 205], "coordinate_system": "top_left_points"}, "normalisation_steps": [{"operation": "parse_decimal"}]},
    {"fact_id": "fact-reported", "field": "reported_nav", "amount": "128450000.000000", "raw_text": "128,450,000.00", "currency": "USD", "scale": "1", "document_id": "doc-statement", "locator": {"kind": "pdf", "page_number": 4, "bbox": [40, 210, 560, 235], "coordinate_system": "top_left_points"}, "normalisation_steps": [{"operation": "parse_decimal"}]}
  ],
  "sources": [
    {"document_id": "doc-opening", "filename": "opening_capital.xlsx", "content_url": "/api/v1/runs/run-atlas-1043/sources/doc-opening"},
    {"document_id": "doc-activity", "filename": "capital_activity.xlsx", "content_url": "/api/v1/runs/run-atlas-1043/sources/doc-activity"},
    {"document_id": "doc-statement", "filename": "capital_statement.pdf", "content_url": "/api/v1/runs/run-atlas-1043/sources/doc-statement"}
  ],
  "commentary": [
    {
      "kind": "finding",
      "text": "Calculated NAV is USD 250,000 above reported NAV, exceeding the USD 0.01 tolerance. The supplied documents do not explain the variance.",
      "check_ids": ["check-roll-forward"],
      "fact_ids": ["fact-opening", "fact-calls", "fact-distributions", "fact-income", "fact-reported"]
    },
    {
      "kind": "next_action",
      "text": "Request an explanation or a revised capital statement from the administrator.",
      "check_ids": ["check-roll-forward"],
      "fact_ids": []
    }
  ],
  "completed_at": "2026-09-20T10:00:08Z"
}
```

Every fact/check ID in commentary resolves within this response; every fact's document ID resolves in `sources`. The public fact field `amount` maps to the stored `normalised_amount`, in actual currency units. Source membership is checked again when bytes are requested. Preserve source currency/scale evidence and extractor versions in stored provenance; include them in fact metadata when relevant. Render snippets/commentary as text, never executable HTML.

Inputs and decisions are immutable after completion. Keep human review independent of arithmetic, but defer review operations: the initial demo can label completed results unreviewed. New inputs and stale-result projections remain supported by the data model and become a UI/API extension when uploads are introduced.

## 5. Keep error and state semantics

The smaller route surface still demonstrates the shared request controls:

| Response | Meaning |
| --- | --- |
| `400` / `422` | Invalid request, date range or unsupported scope |
| `401` / `403` | Missing/invalid identity or forbidden fund/action; no result details leaked |
| `404` | Unknown resource or document not in the requested run's snapshot |
| `409` | `PACK_NOT_READY`, `RUN_ALREADY_ACTIVE` or `IDEMPOTENCY_KEY_REUSED` |
| `429` | Rate limited; include `Retry-After` |
| `503` / `504` | Service unavailable, queue full or timeout; a timed-out POST may have been accepted, so reuse its key |

```json
{
  "schema_version": 1,
  "error": {
    "code": "RUN_ALREADY_ACTIVE",
    "message": "A reconciliation is already running for this fund and period.",
    "request_id": "request-abc",
    "details": {"run_id": "run-atlas-1043"}
  }
}
```

A completed poll returns `200` even when the financial outcome is `mismatch` or `insufficient_evidence`. A technical processing failure is a persisted `failed` run, also read with `200`; it is not a permanent HTTP 500. Never publish partial extraction as a finished decision. Keep idempotency, resource permissions, decimal precision and source lineage in the first slice.

## 6. Extend only when the workflow needs it

| Later capability | Possible extension | What can stay unchanged |
| --- | --- | --- |
| Upload and revise packs | Fund pack upload/read routes, then explicit selection with a revision precondition | Immutable pack manifests and run snapshots |
| Browse long run history | `GET /funds/{fund_id}/runs` with period filter/cursor | Existing run IDs and `GET /runs/{run_id}` |
| Assign/review/sign off | `POST /runs/{run_id}/review-events` with expected review sequence | Separate review state and unchanged check outcomes |
| Large portfolios/evidence | Server pagination/filtering; dedicated evidence reads if payloads grow | Current fields and provenance IDs |
| Edit rules or input selection | Explicit selection/rule commands; add expected revision to run creation | Snapshot rules/tolerance in every run |

Shared runtime schemas and inferred types now live in `packages/contracts`; public and internal security differ but domain shapes can be reused. First acceptance path: authorised fund list → rerun → poll → decision → original cited document. Test forbidden access, duplicate POSTs, exact decimal round-tripping and technical-vs-financial failure states before adding more endpoints.

## Optional agent metadata

The same four endpoints support the optional Python agent workflow. `FundList.processing_mode` (`deterministic` or `agent`) describes new runs. Optional `Run.processing` records the run's actual mode, model/toolset, verification and commentary status, and model/tool/token counters. The mock omits these fields. Policy is frozen at admission; changing configuration does not relabel history.

`csv_record` locators add `version: 1`, a one-based `record_index` across the entire file, `column_index` and `column_name`. Existing `csv.record_number` still counts data records excluding the fixed header. See [agent implementation](agent-implementation.md) for validation and failure semantics.
