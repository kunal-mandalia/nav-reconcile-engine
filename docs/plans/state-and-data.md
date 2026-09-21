# State and data design — demo draft

Status: the first Postgres migration and Python service are implemented; the broader schema below still includes future upload/review extensions. The optional TypeScript mock implements the same public run lifecycle in memory. See [running the mock](../../README.md) and [shared runtime schemas](../../packages/contracts/src/index.ts). Builds on the [implementation plan](provisional.md) and [architecture decisions](architectural-considerations.md). Public request/response sketches are in [API contracts](api-contracts.md). The existing HTML proposal is illustrative and does not yet implement these contracts.

## 1. Scope and ownership

A **reconciliation period** groups one fund and reporting period, including its selected pack, rules and run history. For example, “Atlas Growth Fund IV — Q2 2026” remains the same reconciliation period when a revised pack is uploaded or another run is started. Use `reconciliation_period` as the entity name and **Fund reconciliation** as the UI label.

Working demo assumption: reconcile one whole fund, one reporting period and one base currency. No investor allocation, share-class accounting, FX conversion or valuation verification in the first slice. Keep the selected entity scope explicit so an investor statement cannot accidentally become a whole-fund input. Whole-fund scope and a known input layout are agreed for the demo. Differences in layout should produce needs input; broader adaptation is a later extension.

**Compact first slice:** Seed the funds, periods, pack manifests and rules; keep their selection fixed while the demo runs. Expose only fund listing, run creation, run reads and cited-document reads. A run response embeds decision facts and evidence locations. Public uploads, selection changes, review commands and dedicated history/evidence APIs are later extensions. The broader lifecycle below describes how those extensions fit, not additional first-demo endpoints.

| Owner | Owns | Does not own |
| --- | --- | --- |
| React | Selected fund/period, local filters, open evidence, run progress; a cache of server responses | Authoritative run state, permissions or NAV arithmetic |
| Express | Demo principal and fund grants, public request checks, rate limits, API error mapping, request IDs | Financial calculations, database writes or source files |
| Python/FastAPI | Durable domain state, source files, extraction, rules, background execution and result publication | Public login or user-facing rate-limit policy |
| Postgres + filesystem | Structured records and immutable source bytes, both accessed through Python | Independent application logic |

React polls server state and derives no match decision locally. Express forwards money as strings. Python accepts actor/resource context only from the authenticated Express service, checks scope consistency and enforces domain constraints.

## 2. Separate the three kinds of state

### Pack processing

These transitions initially run through a local seed/import utility before the API server starts, not a public upload API or a second concurrent database writer. The first UI starts from registered packs. Upload and revision controls remain future workflow sketches.

| State | Meaning | Permitted next state |
| --- | --- | --- |
| `received` | Upload stored; immutable manifest reserved | `indexing`, `failed` |
| `indexing` | Inspecting documents, dates, roles and structural ranges | `ready`, `needs_input`, `failed` |
| `ready` | Enough usable documents to attempt extraction/reconciliation | Terminal for this pack version |
| `needs_input` | Known missing, ambiguous or unsupported required inputs | Terminal; upload a revised pack |
| `failed` | Technical indexing failure, e.g. encrypted workbook | Terminal; upload revision or explicitly retry processing as a new attempt |

For the first demo, retrying pack processing creates a new pack version referencing the same source bytes, rather than resetting a terminal pack's state. Pack readiness is not a financial match. If indexing misses a problem, the reconciliation run can still report insufficient evidence.

### Reconciliation execution

| State | Meaning | Permitted next state |
| --- | --- | --- |
| `queued` | Run recorded with frozen inputs; awaiting local worker | `running`, `failed` |
| `running` | Worker is extracting, normalising, checking or publishing | `completed`, `failed` |
| `completed` | A decision and its evidence were committed atomically | Terminal |
| `failed` | Technical failure prevented a decision | Terminal |

Keep `stage` separate: `waiting`, `extracting`, `normalising`, `reconciling`, `publishing`, `finished`. A stage is progress, not a percentage promise. Persist `stage_updated_at`; the UI can display “Taking longer than expected” without inventing failure.

An intentional rerun after a failure creates a new run through the same start command; it never overwrites a finished run. `retry_of_run_id` is an optional later relationship, not a required public command field. Retrying a timed-out request with the same idempotency key returns the original run. Cancellation and automatic retries are deferred. On service restart, mark unfinished demo runs `failed` with `PROCESS_INTERRUPTED`; do not leave them permanently running. This is basic failure detection, not durable job recovery.

### Reconciliation outcome and human review

Only `completed` runs have a non-null `outcome`:

| Outcome | Meaning |
| --- | --- |
| `matched` | All required checks evaluated and passed under the run's rules/tolerance |
| `mismatch` | All required checks evaluated; at least one required comparison failed |
| `insufficient_evidence` | A required check could not be evaluated reliably, even if another check found a discrepancy |

Individual checks use `pass`, `fail` or `not_evaluated`, with reason codes. Missing values are never zero. Conflicting currencies or entity scopes block a numerical NAV conclusion rather than triggering a fabricated difference. Surface any known failed checks even when the overall outcome is `insufficient_evidence`.

Optional checks are advisory: expose failures and missing evidence, but only required checks determine the aggregate outcome. The UI must show check coverage so “matched” cannot be mistaken for validation beyond the configured scope.

Review is independent: `unreviewed`, `in_review`, `approved`, `exception_accepted`. A completed run begins `unreviewed`; `in_review` can return to `unreviewed` or finish in either terminal review state. Approval requires `matched`. Accepting an exception requires `mismatch`, a reviewer and a written reason; it does not change the outcome. `insufficient_evidence` can be investigated but cannot be approved or exception-accepted in this demo. Only a new run can supply a new decision. Full review actions are a later demo slice; initial runs can remain unreviewed.

### Fund-list projection

The list is a server-derived view for a fund and period, not an independently editable status column. Use these rules in priority order:

| Current context | Primary UI status | Additional context |
| --- | --- | --- |
| No selected pack | `no_pack` | Add a pack |
| Selected pack received or indexing | `processing_pack` | Show indexing progress |
| Selected pack needs input | `awaiting_documents` | Name missing/ambiguous input; use “Needs input” for ambiguity |
| Selected pack failed | `processing_failed` | Show safe error and next action |
| Current-pack/current-rule run queued or running | `queued` / `running` | Prior completed result remains separately available |
| Latest current-pack/current-rule attempt failed | `run_failed` | Preserve previous completed result with its own label |
| Latest current attempt completed | `matched`, `mismatch` or `insufficient_evidence` | Show review status separately; label insufficient evidence as “Needs input” |
| Selected pack ready with no run for current rules | `not_run` | A prior result may be out of date |

`is_stale` is separate from the badge: a completed result is stale when its pack ID or rule-configuration hash differs from the currently selected inputs. A newer upload is not current until the user explicitly selects it. Switching current pack or rule selection increments the reconciliation period revision. A newly selected revision can make a previously approved result historical; never carry approval forward automatically. A new rerun against unchanged inputs still receives its own review state.

## 3. Identifiers, numeric values and time

- Generate opaque UUIDs on the server. Human labels such as “Run #1042” are optional display fields, not keys. Examples in API sketches abbreviate IDs for readability.
- Store timestamps in UTC (`TIMESTAMPTZ`); emit RFC 3339 timestamps. Reporting dates and period boundaries are `DATE`, not instants. Period movements cover the declared start and end dates inclusively; opening NAV is as of the preceding date, closing NAV as of the end date.
- Use Python `Decimal` with an explicit calculation precision of at least 50 digits and Postgres `NUMERIC(38,6)` for normalised money. Reject overflow or unsupported precision rather than silently truncating. Round only for display; apply tolerance to the unrounded difference. Return decimal strings over JSON so JavaScript never converts monetary values to binary floating point.
- Keep currency explicitly, with a supported-currency allowlist for the demo. Store scale separately from the original text: `1`, `1000` or `1000000`. Normalise to actual currency units before arithmetic. Unknown currency or scale means unresolved evidence.
- Use non-negative `capital_calls` and `distributions` magnitudes, and signed `net_income`. The formula is `opening_nav + capital_calls - distributions + net_income`. Source signs are preserved and normalisation records how an outflow became a distribution magnitude. Reversals or unusual conventions need explicit mappings; never blindly take an absolute value.
- Store raw documents and extraction blocks without forcing them into the canonical accounting schema. Only the facts used in a decision receive the small typed schema below. This retains the original late-binding design.

Postgres `NUMERIC(38,6)` stores exact decimal quantities but rounds inputs beyond its declared scale. Validate precision, scale and finite values before insertion so unsupported inputs cannot silently change. The TypeScript mock uses `decimal.js`; the persistent service uses Python `Decimal`. [Postgres numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html)

## 4. Logical schemas

The [initial SQL migration](../../fund-service/migrations/001_initial.sql) implements fund, reconciliation_period, pack, document, reconciliation_run, extracted_fact, check_result and idempotency_record. The following table remains the broader target design; selection/review events, unresolved-candidate storage and dedicated commentary tables are deferred. Completed response/commentary JSON is stored on the run alongside typed NUMERIC columns. Snapshot versions/hashes and selected facts are implemented; optional baseline/build-revision metadata remains a future extension. `id` means UUID; `?` means nullable. Enforce foreign keys, required fields, enum/check constraints and uniqueness in the eventual migration where supported, with remaining cross-record invariants enforced transactionally by Python. JSON columns carry versioned structures, not unvalidated arbitrary application state.

The persistent slice stores the fund/period/pack/document records plus runs, selected facts, checks, commentary and run idempotency. `reconciliation_period` remains internal rather than requiring a dedicated API. Selection-event and review-event tables are extension sketches and need not be migrated until those workflows are implemented. Commentary can initially be stored as a versioned JSON array on the run rather than a separate table.

| Entity | Core fields | Constraints and relationships |
| --- | --- | --- |
| `fund` | `id`, `name`, `administrator`, `strategy`, `base_currency`, `created_at` | One fund can have many reconciliation periods. Fund currency changes require a new explicit currency policy for subsequent periods; do not reinterpret historical runs. |
| `reconciliation_period` | `id`, `fund_id`, `period_start`, `period_end`, `entity_scope='fund'`, `currency`, `current_pack_id?`, `current_rule_config JSON`, `rule_config_hash`, `revision INTEGER`, `created_at` | Unique `(fund_id, period_start, period_end, entity_scope)`; start ≤ end. Current pack must belong to this reconciliation period. Revision protects concurrent changes. |
| `reconciliation_period_selection_event` | `id`, `reconciliation_period_id`, `revision INTEGER`, `pack_id?`, `rule_config JSON`, `rule_config_hash`, `actor_id`, `created_at` | Append-only snapshot of each input selection; unique `(reconciliation_period_id, revision)`. Commit alongside the updated reconciliation period. |
| `pack` | `id`, `reconciliation_period_id`, `version INTEGER`, `supersedes_pack_id?`, `state`, `manifest_sha256`, `issues JSON`, `created_by`, `created_at`, `indexed_at?` | Unique `(reconciliation_period_id, version)`. Immutable membership after upload finalisation. Superseded pack must belong to the same reconciliation period. State/issues can change only during processing. |
| `document` | `id`, `pack_id`, `original_filename`, `storage_key`, `sha256`, `media_type`, `byte_size BIGINT`, `role?`, `detected_metadata JSON`, `index_manifest JSON` | Belongs to one pack; content and hash immutable. Same bytes can have new document records in another pack. Storage paths are private. One file can supply several input facts. |
| `reconciliation_run` | `id`, `reconciliation_period_id`, `pack_id`, `retry_of_run_id?`, `state`, `stage`, `outcome?`, `input_snapshot JSON`, `rule_config_hash`, `requested_by`, `request_id`, `created_at`, `started_at?`, `stage_updated_at`, `completed_at?`, `error JSON?` | Run's pack belongs to its reconciliation period. Snapshot fixed at creation; completed outcome and results immutable. Failed runs have a technical error and no financial outcome. |
| `extracted_fact` | `id`, `run_id`, `document_id`, `field`, `raw_text`, `normalised_amount NUMERIC(38,6)?`, `currency?`, `scale?`, `selection_state`, `confidence_score?`, `locator JSON`, `normalisation_steps JSON`, `extractor_version` | `field`: opening NAV, calls, distributions, net income, reported NAV, prior closing NAV. Selection is `selected`, `candidate` or `rejected`; at most one selected fact per run/field in this first slice. Document must be in the frozen pack or explicit baseline input. |
| `check_result` | `id`, `run_id`, `check_type`, `required BOOLEAN`, `status`, `reason_code?`, `expected_amount?`, `reported_amount?`, `difference_amount?`, `tolerance_amount?`, `currency?`, `input_fact_ids JSON`, `details JSON` | Unique `(run_id, check_type)`. Monetary columns use `NUMERIC(38,6)`. Every referenced fact belongs to the run. `not_evaluated` records missing/unreliable inputs without inventing amounts. |
| `decision_commentary` | `id`, `run_id`, `sequence INTEGER`, `kind`, `text`, `check_ids JSON`, `fact_ids JSON`, `template_version` | Ordered statements distinguish observed findings from suggested next actions. Numerical/causal claims require check/fact references. No uncited claim explaining an unknown variance. |
| `review_event` | `id`, `run_id`, `sequence INTEGER`, `action`, `actor_id`, `assignee_id?`, `reason?`, `created_at` | Append-only ownership, note and review changes; unique `(run_id, sequence)`. Current review is projected from events. Compare expected review sequence on writes. Reviewer approval never mutates check outcomes. |
| `idempotency_record` | `actor_id`, `operation`, `key`, `request_hash`, `resource_id`, `created_at`, `expires_at` | Unique `(actor_id, operation, key)`. Links a retry to the original pack/run; different payload under the same key is a conflict. See transaction rules below. |

`selection_state`, `confidence_score` and validation are separate. A parser confidence score does not prove accounting accuracy. Initially use deterministic eligibility rules (known role, period, scope, currency and scale); leave confidence null unless a documented extractor supplies it. If two credible sources disagree, block automatic selection. The current service preserves original sources, reports the conflict and omits an ambiguous selected fact; a dedicated candidate-fact store is a future extension. Final source precedence remains an open business decision.

The first slice expects opening NAV, period totals for calls/distributions/net income and reported closing NAV. Large underlying tables remain raw/indexed. If a total is computed from many rows later, add explicit contributing fact IDs and an aggregation operation; do not cite a made-up total cell.

Demo users and their fund grants can remain Express-side fixtures rather than extra identity tables. Persist stable actor IDs for audit even when display names change.

Review event actions are `assign`, `add_note`, `start_review`, `return_unreviewed`, `approve` and `accept_exception`. Assignment and notes do not implicitly change review state. Terminal review decisions remain part of history; reopening or revoking approval is deferred to an explicit future workflow.

### Frozen run inputs

Every run's `input_snapshot` includes a schema version, reconciliation period scope/dates/currency, selected pack ID/version/manifest hash, document IDs/hashes, baseline document IDs/hashes if used, ruleset version, configured required checks, decimal tolerance, extractor/mapping versions and application build revision. The selected reconciliation period rules must be a server-owned configuration; clients cannot supply a tolerance override when rerunning.

For the first slice require the capital roll-forward and input period/scope/currency alignment. Enable opening-balance continuity only when an explicit prior closing statement is included in the snapshot. If configured as required but no baseline is available, it is `not_evaluated` and the outcome is `insufficient_evidence`. Otherwise display it as optional/not evaluated; never claim “3 of 3 pass” by default.

### Example source locator and normalisation

```json
{
  "schema_version": 1,
  "document_id": "doc-activity-v2",
  "field": "distributions",
  "raw_text": "(4,000)",
  "normalised_amount": "4000000.000000",
  "currency": "USD",
  "scale": "1000",
  "selection_state": "selected",
  "confidence_score": null,
  "locator": {
    "kind": "spreadsheet",
    "sheet": "Q2 movements",
    "range": "F25"
  },
  "normalisation_steps": [
    {"operation": "parse_accounting_number", "output": "-4000"},
    {"operation": "apply_scale", "factor": "1000", "output": "-4000000"},
    {"operation": "distribution_outflow_to_magnitude", "output": "4000000"}
  ]
}
```

The stored fact also needs an extractor version and evidence for currency/scale: e.g. the header cell reading “USD in thousands”, preserved as a locator in the normalisation step or extraction metadata. The displayed source figure must show original units as well as normalised units.

Other locator variants: PDF `{kind, page_number, bbox, coordinate_system}` with one-based page number and top-left origin in points; CSV `{kind, record_number, column_name, column_index}` with a one-based data-record number excluding the header, not a physical line number, and a one-based column index. Store PDF page dimensions/rotation in the index. Original bytes plus coordinates are the provenance; an explanatory snippet alone is insufficient.

## 5. Decision algorithm and commentary

1. Read the frozen manifest; confirm documents belong to the run's reconciliation period/pack or approved baseline.
2. Extract candidates with raw values, locations, units and parser versions. Validate field semantics and select a unique eligible fact for each required field.
3. If a required fact is missing, conflicting or has unresolved scope/currency/scale, create a `not_evaluated` check with a specific reason. Missing income is not zero income.
4. Calculate the roll-forward with Decimal. Define `difference = calculated_nav - reported_nav`. Pass when `abs(difference) <= absolute_tolerance`. Agreed demo tolerance is `0.010000` in the reconciliation period currency, not a settled production policy.
5. Evaluate configured additional checks, aggregate the outcome using the rules above, and generate short deterministic commentary linked to check/fact IDs.
6. Commit results, commentary and terminal run status together. Expose completed results only after this commit.

Example: `120000000 + 12000000 - 4000000 + 700000 = 128700000`. Reported NAV `128450000` gives `+250000`, outside the agreed demo USD 0.01 tolerance. State the discrepancy; suggest requesting an administrator explanation without asserting a hidden fee or adjustment caused it.

## 6. Transactions, retries and versioning

For the compact demo, implement Start, Queue admission, Duplicate request, Request hash and Publish. Local import follows the file-integrity rules under Upload, but public upload, selection and review mutations are deferred.

- **Upload:** Stream into a temporary directory with size limits and safe archive extraction. Persist source bytes under server-generated storage keys, verify hashes, then commit the pack/document manifest. A crash can leave unreferenced files to clean up; it must not expose a ready pack pointing to missing files. Reject archive traversal and oversized expansion. Capture MIME from inspection rather than filename alone.
- **Revised packs:** Treat each pack as a complete manifest, even if its unchanged documents reuse stored bytes. New versions may include the same documents plus a replacement; do not silently combine “latest files” across versions at read time. Keep `supersedes_pack_id`. Uploading alone does not switch the reconciliation period's current pack.
- **Select inputs:** Use the reconciliation period `revision` to select a pack or update rules. A stale revision yields `409 Conflict`; selection changes are recorded with actor/time. A historical result retains its original input snapshot and review events.
- **Start:** After checking current access, acquire a lock scoped to the reconciliation period and check the idempotency record before applying new-run preconditions. For a new key, verify the period belongs to the supplied fund and its seeded pack is ready, enforce no active run for that period, snapshot selected inputs, insert queued run and idempotency record in a transaction, then commit before returning `202`. Inputs are fixed for the compact demo, so clients need only send the period ID. When runtime input selection is introduced, add an expected revision precondition for new requests while still replaying existing matching requests. Do not dispatch work before the queued row is durable. Any semantic request change under a reused key yields `409`.
- **Queue admission:** Implemented with a bounded Postgres queue, so run insertion and dispatch visibility are one commit. No separate in-memory enqueue can lose a committed job. Check idempotency replay before queue capacity. The more general external-queue extension below is deferred. Reserve capacity before committing a new run; if full, return `503 QUEUE_FULL` without creating a run or consuming the key. Release the reservation if the transaction fails. Enqueue only after commit; if dispatch then fails, persist `failed / DISPATCH_FAILED` on that same run so a retry retrieves a terminal result rather than leaving an orphaned queued run. A process crash between commit and dispatch is handled by the restart policy above.
- **Duplicate request:** Same principal, operation, key and request hash returns the same resource with current state, including after a client timeout. Recheck current access before replaying. Retain keys for the demo session, with a documented production retention window to be decided. A new intentional rerun uses a new key; a concurrent active run produces `409 RUN_ALREADY_ACTIVE` with its ID.
- **Request hash:** For demo run creation, hash the operation, target fund ID and reconciliation period ID. Exclude request IDs and transport details. Bind the created run to its frozen pack/rules in the same transaction. Later, include expected revision and other new semantic command fields in the hash; uploads should use content hashes and meaningful metadata rather than multipart boundaries. Preserve the original request when retrying after a timeout.
- **Publish:** Write facts, checks, commentary and completed state in one short transaction after processing. Failed runs may retain diagnostic extraction artifacts, but they have no published financial decision. A newer selected pack never changes an older run while it executes.
- **Review:** Validate the proposed transition and expected review sequence, then append an event transactionally. Review commands apply to an explicit run ID. Historical approval remains historical when current inputs change.

Implemented service runtime: Postgres in local Docker Compose, one Python server process and a bounded reconciliation worker. Lock the reconciliation-period row when admitting a run and enforce at most one active run per period with a partial unique index. Keep transactions short; file parsing happens outside them. Express never accesses Postgres or source storage directly. The optional mock uses a single-process in-memory adapter with elapsed-time stages, no queue or durability; restarting resets all runs and idempotency keys.

## 7. First implementation slices and review cases

| Slice | Deliverable | Useful verification |
| --- | --- | --- |
| 1. Read path | Seed fund, reconciliation-period, pack and run records; fund list, combined run detail/evidence, and original-source reads | Forbidden funds absent from lists; IDs cannot cross fund boundaries; decimal strings survive round-trip |
| 2. State path | Idempotent run creation, polling, bounded local worker, atomic publication | Double click creates one run; service timeout then retry reuses ID; restart marks unfinished runs failed; active-run conflict visible |
| 3. Real reconciliation | One known CSV/Excel pack layout, PDF source support where reliably extractable, canonical facts and Decimal check | Match; positive and negative variance; bracket/scale handling; missing vs zero; unknown currency; conflicting sources; tolerance boundary |
| Later: revision path | Upload/version/select revised pack; stale-result projection; history browser | Old evidence unchanged after revision; old run completing cannot become the current result for a new pack |
| Later: review path | Owner, notes and approval/exception acceptance | Approval cannot turn mismatch into match; concurrent review conflict; revision never inherits approval |

The static prototype's success and failure funds can become these fixtures. Draft fixtures should include six cases: matched, mismatch, missing input, unreadable file, wrong scope/currency and duplicate request. Add a revised pack with a changed NAV to demonstrate resolution through new evidence rather than editing history.

## 8. Decisions still open

- Whole-fund scope is agreed for the demo. A future investor-account extension needs a separate account identity and reconciliation period key.
- Demo checks are input alignment and capital roll-forward, with a 0.01 tolerance in the fund currency and six decimal places. Confirm evidence precedence and production policy before expanding beyond the known layout.
- Review actions are a documented follow-on to the compact demo; state/schema support does not imply a complete approval product.
- Set actual upload, concurrency, queue and rate limits from sample packs and available demo hardware. Identify what to do when an administrator pack cannot be safely parsed.
- Current fixtures: Alex has operations access to all six funds; Priya has read-only access to Meridian and Cove. Real login, durable jobs, FX, multi-tenant operation, editable extraction mappings and live VLM/Jev integration remain outside the initial slice.
