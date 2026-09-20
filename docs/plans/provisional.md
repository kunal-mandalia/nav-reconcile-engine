# High-Level Implementation Plan: Institutional Fund Pack NAV Reconciliation Engine

This plan is structured for a coding agent to implement a simplified end-to-end prototype for Wednesday's demo.

Agreed stack: **React → Node.js/Express client API → Python/FastAPI reconciliation service → local DuckDB and filesystem**. The repository currently contains a standalone HTML UX proposal; these application components remain to be built. See [architectural considerations](architectural-considerations.md) for the trust boundary and demo scope.

Detailed draft: [state, data and logical schemas](state-and-data.md), plus [API contracts](api-contracts.md). These sketches propose a fund-level first slice, immutable packs/runs and separate execution, outcome and review states.

**Compact demo scope:** Four public endpoints: list funds, start a run, read a run (including commentary and evidence), and read an original cited source. Seed sample packs/rules locally. Public uploads, pack selection, review actions, exports and a dedicated history browser are later extensions; their appearance in the HTML proposal is not a first-demo requirement.

---

## Phase 1: Project Setup & Core Infrastructure
* **Repository Structure:** Create a React frontend in `/apps/web`, a Node.js/Express client API in `/apps/client-api`, and a Python service in `/services/reconciliation` with ingestion, indexing, extraction and reconciliation modules.
* **Dependencies:** Use a Node package manager for React and Express. Initialize Poetry or `uv` for Python with `fastapi`, an ASGI server, `duckdb`, `polars`, `openpyxl`, `python-calamine` and `pymupdf` (fitz).
* **State Management:** Set up local DuckDB and file-system directories for raw uploads (`/data/bronze`) and structured outputs (`/data/silver`). Python owns persistence; the client API accesses data through the service.
* **Local Runtime:** Expose Express as the client-facing API. Keep FastAPI on loopback or an internal container network, with a configured service credential available only to server processes. Route all React API calls through Express.

---

## Phase 1A: Client API & Shared Request Controls

* **Identity & Access:** Implement explicitly enabled mock identity fixtures with fixed fund permissions. Express defines authorised fund/action scope and forwards it as trusted service context; Python checks resource ownership within that scope before returning runs or sources. Filter fund lists to permitted funds. No additional ownership-lookup endpoint is required.
* **Rate Limiting:** Add a basic in-memory limiter for a single Express instance. Demonstrate `429` responses with retry guidance, using separate budgets for expensive reruns and frequent status polling. Distributed limits are a production discussion item.
* **Request Handling:** Validate public payloads, assign/propagate request IDs, set downstream timeouts and return clear errors without exposing service credentials. Add public upload limits when that extension is built.
* **Internal Calls:** Mirror the four operations under private FastAPI routes, using the server-side credential and trusted actor/fund scope. Python validates service identity, resource membership and business rules; it does not duplicate the public login or rate-limit stack.
* **API Contract:** Implement `GET /funds`, `POST /funds/{fund_id}/runs`, `GET /runs/{run_id}` and `GET /runs/{run_id}/sources/{document_id}` under `/api/v1`. Embed facts/locators in the run response. Starting a run returns `202 Accepted`; polling remains responsive while processing runs.
* **Scope:** Production token verification through an identity provider, distributed rate limits and service-credential lifecycle management are discussion topics. Mock identity must be clearly labelled and restricted to demo mode.

---

## Phase 2: Ingestion Gateway & Unified Indexer (Step 1)
* **Local Pack Import:** Use a local seed/import utility to register sample quarterly ZIP packs, extract contents safely, and log document hashes, paths and MIME types. Select packs/rules before the demo starts. Extraction and reconciliation still operate on actual sample files. A public upload route is deferred.
* **MIME Routing & Fast Paths:**
  * **CSVs:** Run a quick delimiter check; if contiguous, route to direct DuckDB streaming.
  * **Excel (`.xlsx`):** Implement a structural pre-pass using `calamine` or `openpyxl(read_only=True)` to read populated sheet dimensions and skip empty cells in $O(K)$ time.
  * **PDFs:** Register page counts and extract text blocks/bounding boxes using `pymupdf`.
* **Output:** Generate an index manifest mapping files to sheets, tables, and spatial coordinate ranges.

---

## Phase 3: Extraction & Normalization Layer
* **Tabular Ranged Reads:** Implement format-specific extraction workers:
  * Pull specific ranges (e.g., `A52:H110`) from Excel sheets directly into temporary DataFrames.
  * Stream clean CSVs via zero-copy DuckDB/Arrow memory.
* **Accounting Normalization:** Write helper functions to clean financial strings:
  * Parse accounting brackets `(1,250.00)` with Python `Decimal`, preserving raw text and source location. Store normalised money in DuckDB `DECIMAL(38, 6)` and return decimal strings through the API.
  * Parse currency and scale notes (e.g., "in thousands") with evidence for their interpretation. Use positive call/distribution magnitudes and signed net income; record sign transformations to avoid deducting a bracketed distribution twice.
* **Schema Persistence:** Store extracted tables in local DuckDB with lineage metadata back to the source file. PostgreSQL JSONB remains a later alternative rather than a second demo datastore.

---

## Phase 4: Mathematical Reconciliation & Control Layer
* **Accounting Invariant Verifier:** Implement automated check routines for NAV schedules:
  * Formula: $\text{Beginning Capital} + \text{Capital Calls} - \text{Distributions} + \text{Signed Net Income} = \text{Ending Capital}$
* **HITL Exception Gating:** Persist check results, source facts and commentary with the completed decision. A review queue projects mismatches or insufficient evidence from these records; technical failures remain separate. Do not publish uncertain inputs as verified data, or treat a parser confidence score as proof of accounting accuracy.
* **Jev Integration Mock:** Create a lightweight stub/wrapper for Jev or deterministic rules to handle routing decisions and confidence score evaluation.
* **Run Lifecycle:** Freeze pack version, reporting period, rule version, tolerance and request/actor context for each run. Use persistent idempotency keys and controlled background work in Python. Preserve prior results on rerun and return status, commentary and provenance through Express. On restart mark interrupted demo runs failed; durable scheduling and automatic recovery are outside the initial demo.

---

## Phase 5: Frontend Demo UI
* **Framework & Reference:** Build React views using [the HTML UX proposal](../proposals/nav-reconciliation-ux.html) as the reference. All data and actions use the Express API; there are no direct browser calls to FastAPI.
* **Fund Overview:** Show funds, reporting period, NAV status and actions to rerun or investigate a reconciliation.
* **Input Context:** Show the seeded pack version and reporting period. Defer the prototype's upload/revision controls until public intake is implemented.
* **Pipeline Dashboard:** A view displaying step-by-step progress:
  1. Ingestion & Indexing
  2. Extraction & Normalization
  3. NAV Math Reconciliation Status (matched, mismatch, awaiting documents, running or processing failure)
* **Query & Result View:** Show capital balances, commentary, source facts/locations and next actions from one run response; source links stream original documents. Preserve older runs by ID but defer a dedicated history browser. Keep approval separate and initially unreviewed.
* **API Feedback:** Explain access-denied, rate-limited and service-unavailable responses, preserve the current view on failure and avoid duplicate rerun submissions. Label the demo identity clearly.

---

## Phase 6: Interview Walkthrough & Boundary Checks

* Demonstrate an authorised rerun of a seeded sample pack, prompt return of a run ID, progress polling and a source-backed result.
* Verify missing/invalid demo identity receives `401`, a disallowed fund action receives `403`, and a rate-limited request receives `429` before reconciliation is started.
* Verify fund lists exclude unauthorised funds, run IDs and source IDs cannot bypass fund permissions, and FastAPI rejects calls without a valid service credential.
* Verify frontend API calls target Express and FastAPI is not publicly exposed; trace one request across both services with its request ID.
* Discuss replacing demo identity with production identity verification, sharing rate limits across API instances, securing service identity, and moving long-running jobs to durable workers.
* Explain how pack intake/selection, paginated history and review commands can be added without changing the core four-endpoint journey.
