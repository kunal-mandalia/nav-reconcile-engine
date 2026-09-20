# High-Level Implementation Plan: Institutional Fund Pack NAV Reconciliation Engine

This plan is structured for a coding agent to implement a simplified end-to-end prototype for Wednesday's demo.

---

## Phase 1: Project Setup & Core Infrastructure
* **Repository Structure:** Create a clean Python project layout (`/src/ingestion`, `/src/indexer`, `/src/extraction`, `/src/reconciliation`, `/src/ui`).
* **Dependencies:** Initialize Poetry or `uv` with core packages: `duckdb`, `polars`, `openpyxl`, `python-calamine`, `pymupdf` (fitz), and a lightweight web UI framework (Streamlit or FastAPI + simple HTML).
* **State Management:** Set up a local DuckDB instance and file-system directories for raw uploads (`/data/bronze`) and structured outputs (`/data/silver`).

---

## Phase 2: Ingestion Gateway & Unified Indexer (Step 1)
* **Bundle Unzipping:** Build an ingestion endpoint that accepts a quarterly fund pack ZIP container, extracts contents, and logs file paths and MIME types.
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
* **Schema Persistence:** Store extracted tables in semi-structured PostgreSQL JSONB or local DuckDB tables with lineage metadata back to the source file.

---

## Phase 4: Mathematical Reconciliation & Control Layer
* **Accounting Invariant Verifier:** Implement automated check routines for NAV schedules:
  * Formula: $\text{Beginning Capital} + \text{Capital Calls} - \text{Distributions} \pm \text{Net Income} = \text{Ending Capital}$
* **HITL Exception Gating:** If math invariants fail or parsing confidence drops below threshold, route the affected record to an exception queue file instead of the gold layer.
* **Jev Integration Mock:** Create a lightweight stub/wrapper for Jev or deterministic rules to handle routing decisions and confidence score evaluation.

---

## Phase 5: Frontend Demo UI
* **Upload Component:** A simple drag-and-drop interface for uploading quarterly fund pack ZIP bundles.
* **Pipeline Dashboard:** A view displaying step-by-step progress:
  1. Ingestion & Indexing
  2. Extraction & Normalization
  3. NAV Math Reconciliation Status (Pass/Fail flags)
* **Query & Result View:** A clean summary panel showing reconciled capital account balances and flagged exception items ready for auditor review.