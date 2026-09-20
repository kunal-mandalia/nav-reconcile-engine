# API contracts — compact demo

Proposed contracts, not implemented endpoints. The first demo exposes **four public endpoints** covering the requested fund list, status, rerun and decision/source drilldown. The [state and data design](state-and-data.md) preserves the domain model without exposing every entity as a resource API.

## 1. Demo scope and conventions

Seed funds, reconciliation periods, complete document packs and rules locally. Use actual sample documents for extraction; seeded inputs do not mean simulated reconciliation. Keep input selection fixed while the demo runs. Upload, pack selection, rule editing, review commands and dedicated history routes are extensions, not prerequisites.

A `reconciliation_period` remains the internal grouping for a fund and reporting period. Return `reconciliation_period_id` where the UI needs it to start a run; there is no separate `/reconciliation-periods` endpoint. The UI label remains **Fund reconciliation**. IDs in examples are abbreviated; implementations use UUIDs.

React calls `/api/v1` on Express; Python exposes the corresponding four operations under `/internal/v1`. Express owns demo identity, fund permission checks, rate limits, validation and request IDs. Python owns reconciliation, persistence and idempotency. Private service credentials and trusted actor/fund context are never accepted directly from the browser.

For lists, Express forwards the caller's authorised fund IDs and Python filters before returning any rows or counts. For run/source access, Express forwards that allowlist as trusted scope; Python verifies resource ownership before returning data. Express defines user permissions; Python enforces resource membership against the supplied scope. This avoids a separate ownership-lookup endpoint. Rerun permission is checked by Express as well as the target fund's membership in the read/write scope.

Use decimal strings for money, UTC RFC 3339 event timestamps and date-only reporting boundaries. Null is unknown, not zero. JSON responses include `schema_version: 1`; binary source responses use their document media type. Return and propagate `X-Request-ID`; request IDs trace attempts, while idempotency keys identify one intended mutation. Reject unknown command fields.

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

The complete example below embeds the selected facts and original-source links. There is no additional evidence lookup. During processing return run identity/state/stage with `outcome: null` and no final decision fields. On technical failure include a safe `error`; after completion return the immutable decision:

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
    "absolute_tolerance": "100.000000"
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
      "tolerance_amount": "100.000000",
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
      "text": "Calculated NAV is USD 250,000 above reported NAV, exceeding the USD 100 tolerance. The supplied documents do not explain the variance.",
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

Generate shared types from the four operation schemas when implementation starts; public and internal security differ but domain shapes can be reused. First acceptance path: authorised fund list → rerun → poll → decision → original cited document. Test forbidden access, duplicate POSTs, exact decimal round-tripping and technical-vs-financial failure states before adding more endpoints.
