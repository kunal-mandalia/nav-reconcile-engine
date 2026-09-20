# Architecture & Key Decision Points: Institutional Fund Pack NAV Reconciliation Engine

This document outlines the planned architecture for automated private market fund pack ingestion and NAV reconciliation. The current repository contains plans and a standalone HTML/CSS/JavaScript UX prototype; the application services described here are not implemented yet.

The agreed interview demo stack is **React frontend → Node.js/Express client API → Python/FastAPI reconciliation service → local DuckDB and filesystem storage**.

The proposed [state and data design](state-and-data.md) and [API contracts](api-contracts.md) define the next level of detail: immutable run inputs, independent execution/outcome/review states, decimal money, schemas and request semantics.

The compact first demo uses four public operations: list funds, start a run, read its result/evidence and retrieve a cited document. Packs/rules are seeded locally; upload, input selection and review APIs remain extensions. The broader responsibilities below describe the intended architecture beyond this first slice.

---

## 1. The Core Problem
Private market fund administrators (e.g., Citco, SS&C) deliver heterogeneous multi-file reporting packages containing Schedule of Investments, Trial Balances, and Partner Capital Statements. These arrive in mixed MIME types (PDF, Excel, CSV, scanned images) with unpredictable layouts, multi-thousand-row spreadsheets, and floating summary blocks. 

The goal of this pipeline is to ingest these quarterly/monthly packages, perform reliable extraction, verify balance-sheet math invariants, and persist verified data for downstream analytical Q&A.

---

## 2. Architectural Decision Points

### A. Late-Binding Ranged Reads vs. Upfront Schema Locking (ELT over ETL)
* **The Trade-off:** Eagerly cleaning and transforming messy financial packs into rigid SQL schemas upfront risks breaking or dropping data when administrators alter their layouts or add non-standard footnotes.
* **The Decision:** We utilize **Late-Binding Ranged Reads supported by Semi-Structured Persistence (Postgres JSONB / DuckDB)**. 
* **Why:** Retains original documents and extraction coordinates for later inspection. A small typed schema captures only selected accounting facts and decisions; heterogeneous source tables remain indexed and semi-structured.

### B. Ingestion Cadence & Processing Budget (Batch vs. Real-Time)
* **The Trade-off:** Sub-second real-time API latency versus deep structural extraction accuracy.
* **The Decision:** Designed for a **monthly/quarterly batch processing window**.
* **Why:** Because reports arrive periodically, we can afford a 30–90 second deep extraction, layout profiling, and validation check upfront. This cadence also makes **Human-in-the-Loop (HITL) review queues** viable for edge cases and schema drift before data lands in the gold layer.

### C. Deterministic Core vs. Agentic Escalation (The 90/10 Rule)
* **The Trade-off:** Relying entirely on generative LLMs/VLMs for tabular parsing is slow, expensive, and prone to hallucinations on numbers.
* **The Decision:** 
  * **90% Deterministic Core:** Plans Python/Rust tooling (DuckDB, `calamine`, PyMuPDF) for CSV and spreadsheet extraction, with Python `Decimal` and DuckDB `DECIMAL(38, 6)` for reconciliation amounts. Binary floating point is not exact monetary arithmetic; JSON amounts are decimal strings. The split is a design target, not a measured result.
  * **10% Agentic & VLM Escalation:** Reserved exclusively for ambiguous layouts, unmerging messy cells, and parsing unstructured footnotes.

### D. System One Control Layer (Jev Integration)
* **The Trade-off:** Heavy LLM prompt loops introduce high latency and token costs for basic routing tasks.
* **The Decision:** Uses **Jev** as a high-speed, deterministic control layer for pipeline routing, sheet classification, and calibrated confidence gating.
* **Why:** Provides typed, probabilistic outputs (`Choice`, `Score`) in milliseconds with zero prose overhead, routing files cleanly between the direct CSV path, sparse Excel profiler, and VLM visual pipelines.

### E. Client API Boundary (Node.js/Express)

* **The Trade-off:** An additional service adds an HTTP boundary and operational overhead, but gives the interview demo a clear place to demonstrate shared request controls independently of financial processing.
* **The Decision:** All browser API requests go through a **Node.js/Express client API**. The **Python/FastAPI service** owns ingestion, extraction, reconciliation, commentary, provenance and persistence.
* **Why:** Authentication, fund-level authorisation, rate limiting and request tracing can be applied consistently at the client API without implementing the full user-facing middleware stack in every downstream service.

| Component | Planned responsibility |
| --- | --- |
| React frontend | Fund list, status, upload/rerun actions, progress, commentary, source evidence and run history. Calls only the Express client API. |
| Node.js/Express client API | Authenticate the caller; authorise access to the requested fund, pack, run or source; limit requests; validate public request shapes; apply upload limits; propagate request IDs; forward authorised calls to Python. |
| Python/FastAPI service | Authenticate the calling service, validate internal inputs, register runs, process documents, enforce reconciliation rules and return results with source references. Own DuckDB and file access. |
| Local DuckDB and filesystem | Persist funds, pack versions, run state, results, exceptions and provenance; preserve uploaded source files and extracted outputs. Accessible through Python rather than directly from the browser or Node. |

**Network and trust boundary:** Express is the only externally reachable application API. FastAPI is reachable only by the client API over a private network or loopback in the local demo, and requires a server-side service credential. Database and file storage remain internal. The frontend must never receive that credential. Express derives user and fund context from authenticated identity and trusted resource metadata, rather than trusting caller-supplied identity or ownership headers. Python checks the trusted service context and domain rules; private networking alone does not authenticate a request.

**Demo implementation:** Use an explicitly enabled mock identity with fixed fund permissions, basic single-instance rate limiting, request validation and request IDs. Demonstrate `401` for missing/invalid demo identity, `403` for a forbidden fund action, and `429` with retry guidance for throttling. Express supplies trusted allowed-fund/action scope to Python, which checks resource membership before returning data; no dedicated ownership-lookup endpoint is needed. Mock identity is a local demonstration fixture, not production authentication. Use a configured service credential between Express and FastAPI. Production identity-provider integration, distributed rate-limit storage, credential rotation and stronger service identity are discussion topics, not demo prerequisites.

**Long-running work:** An authorised start request goes through Express to FastAPI, which records a run and returns its ID with `202 Accepted`. Python performs the reconciliation in background work; React polls status and results through Express. Authorisation also applies to polling, history, exports and source retrieval. Rate limits should distinguish costly upload/rerun requests from routine status polling. The demo can use one Python process with controlled concurrency; a durable queue and recovery after process restarts remain future work.

**Architecture reference:** The shared `system-architecture` diagram shows the agreed React → Express → FastAPI boundary. Read it with `rc architecture show system-architecture`. RC manages the diagram separately from these repository documents.

---

## 3. High-Level Ingestion & Processing Flow

1. **Client API:** React submits a pack or rerun request to Express, which applies identity, fund-access, rate-limit and request checks before calling the internal FastAPI service.
2. **Ingestion Gateway (Python):** Unzips bundle, inspects MIME types, and registers raw files (Bronze layer).
3. **Unified Indexer (Step 1):** Maps structural boundaries. Sparse-row pre-pass scans Excel XML nodes or memory-mapped CSV bytes without loading empty cells.
4. **Deep Extraction & Normalization:** Format-specific workers parse ranged slices, unmerge cells, normalize accounting brackets (`(1,250)` $\rightarrow$ `-1250.00`), and standardize dates.
5. **Mathematical Reconciliation:** Tests the initial roll-forward using non-negative call/distribution magnitudes and signed net income:
   $$\text{Beginning Capital} + \text{Capital Calls} - \text{Distributions} + \text{Signed Net Income} = \text{Ending Capital}$$
6. **Persistence & HITL Gating:** Persist checks, evidence and the run decision together. Missing evidence, financial mismatches and technical failures remain distinct. The review queue is a projection of stored results; reviewer approval is separate from arithmetic match. Python serves status, commentary, history and cited source evidence through Express to the authorised frontend caller.
