# High-Level Implementation Plan: Institutional Fund Pack NAV Reconciliation Engine

This plan is structured for a coding agent to implement a simplified end-to-end prototype for Wednesday's demo.

Agreed stack: **React → Node.js/Express client API → Python/FastAPI reconciliation service → local DuckDB and filesystem**. The repository currently contains a standalone HTML UX proposal; these application components remain to be built. See [architectural considerations](architectural-considerations.md) for the trust boundary and demo scope.

---

## Phase 1: Project Setup & Core Infrastructure
* **Repository Structure:** Create a React frontend in `/apps/web`, a Node.js/Express client API in `/apps/client-api`, and a Python service in `/services/reconciliation` with ingestion, indexing, extraction and reconciliation modules.
* **Dependencies:** Use a Node package manager for React and Express. Initialize Poetry or `uv` for Python with `fastapi`, an ASGI server, `duckdb`, `polars`, `openpyxl`, `python-calamine` and `pymupdf` (fitz).
* **State Management:** Set up local DuckDB and file-system directories for raw uploads (`/data/bronze`) and structured outputs (`/data/silver`). Python owns persistence; the client API accesses data through the service.
* **Local Runtime:** Expose Express as the client-facing API. Keep FastAPI on loopback or an internal container network, with a configured service credential available only to server processes. Route all React API calls through Express.

---

## Phase 1A: Client API & Shared Request Controls

* **Identity & Access:** Implement explicitly enabled mock identity fixtures with fixed fund permissions for the local interview demo. Add authentication and fund-authorisation middleware. Filter fund lists to the caller's permitted funds. Resolve the parent fund of each pack, run or source from trusted metadata before granting access; apply checks to reads, exports and evidence as well as writes.
* **Rate Limiting:** Add a basic in-memory limiter for a single Express instance. Demonstrate `429` responses with retry guidance, using separate budgets for expensive uploads/reruns and frequent status polling. Distributed limits are a production discussion item.
* **Request Handling:** Validate public payloads and upload sizes, assign/propagate request IDs, set downstream timeouts and return clear errors without exposing service credentials.
* **Internal Calls:** Forward authorised requests to FastAPI using the server-side credential and trusted actor/fund context. Python authenticates the service and validates internal inputs and business rules; it does not duplicate the public login or rate-limit stack.
* **API Contract:** Cover fund listing, pack upload, run creation, status polling, result/history reads and cited-source retrieval. Starting a run returns `202 Accepted` with a run ID after Python records it. Polling must remain responsive while background processing runs.
* **Scope:** Production token verification through an identity provider, distributed rate limits and service-credential lifecycle management are discussion topics. Mock identity must be clearly labelled and restricted to demo mode.

---

## Phase 2: Ingestion Gateway & Unified Indexer (Step 1)
* **Bundle Unzipping:** React uploads a quarterly fund pack ZIP via the Express client API. The internal FastAPI ingestion endpoint accepts the authorised request, extracts contents, and logs file paths and MIME types.
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
  * Convert accounting brackets `(1,250.00)` to negative floats `-1250.00`.
  * Strip currency symbols and parse scale notes (e.g., "in thousands").
* **Schema Persistence:** Store extracted tables in local DuckDB with lineage metadata back to the source file. PostgreSQL JSONB remains a later alternative rather than a second demo datastore.

---

## Phase 4: Mathematical Reconciliation & Control Layer
* **Accounting Invariant Verifier:** Implement automated check routines for NAV schedules:
  * Formula: $\text{Beginning Capital} + \text{Capital Calls} - \text{Distributions} \pm \text{Net Income} = \text{Ending Capital}$
* **HITL Exception Gating:** If math invariants fail or parsing confidence drops below threshold, route the affected record to an exception queue file instead of the gold layer.
* **Jev Integration Mock:** Create a lightweight stub/wrapper for Jev or deterministic rules to handle routing decisions and confidence score evaluation.
* **Run Lifecycle:** Record pack version, reporting period, rule version, tolerance and request/actor context for each run. Execute processing as controlled background work in Python. Preserve prior results on rerun and return status, commentary and provenance through the Express API. Durable job scheduling and restart recovery are outside the initial demo.

---

## Phase 5: Frontend Demo UI
* **Framework & Reference:** Build React views using [the HTML UX proposal](../proposals/nav-reconciliation-ux.html) as the reference. All data and actions use the Express API; there are no direct browser calls to FastAPI.
* **Fund Overview:** Show funds, reporting period, NAV status and actions to rerun or investigate a reconciliation.
* **Upload Component:** A simple drag-and-drop interface for uploading quarterly fund pack ZIP bundles.
* **Pipeline Dashboard:** A view displaying step-by-step progress:
  1. Ingestion & Indexing
  2. Extraction & Normalization
  3. NAV Math Reconciliation Status (matched, mismatch, awaiting documents, running or processing failure)
* **Query & Result View:** Show reconciled capital balances, decision commentary, cited source locations, exception next actions and run history. Keep arithmetic match separate from human approval.
* **API Feedback:** Explain access-denied, rate-limited and service-unavailable responses, preserve the current view on failure and avoid duplicate rerun submissions. Label the demo identity clearly.

---

## Phase 6: Interview Walkthrough & Boundary Checks

* Demonstrate a successful authorised upload/rerun, prompt return of a run ID, progress polling and a source-backed result.
* Verify missing/invalid demo identity receives `401`, a disallowed fund action receives `403`, and a rate-limited request receives `429` before reconciliation is started.
* Verify fund lists exclude unauthorised funds, run IDs and source IDs cannot bypass fund permissions, and FastAPI rejects calls without a valid service credential.
* Verify frontend API calls target Express and FastAPI is not publicly exposed; trace one request across both services with its request ID.
* Discuss replacing demo identity with production identity verification, sharing rate limits across API instances, securing service identity, and moving long-running jobs to durable workers.
