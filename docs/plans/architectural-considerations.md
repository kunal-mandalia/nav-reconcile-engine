# Architecture & Key Decision Points: Institutional Fund Pack NAV Reconciliation Engine

This document outlines the core architectural principles, trade-offs, and design patterns implemented in this repository for automated private market fund pack ingestion and NAV reconciliation.

---

## 1. The Core Problem
Private market fund administrators (e.g., Citco, SS&C) deliver heterogeneous multi-file reporting packages containing Schedule of Investments, Trial Balances, and Partner Capital Statements. These arrive in mixed MIME types (PDF, Excel, CSV, scanned images) with unpredictable layouts, multi-thousand-row spreadsheets, and floating summary blocks. 

The goal of this pipeline is to ingest these quarterly/monthly packages, perform reliable extraction, verify balance-sheet math invariants, and persist verified data for downstream analytical Q&A.

---

## 2. Architectural Decision Points

### A. Late-Binding Ranged Reads vs. Upfront Schema Locking (ELT over ETL)
* **The Trade-off:** Eagerly cleaning and transforming messy financial packs into rigid SQL schemas upfront risks breaking or dropping data when administrators alter their layouts or add non-standard footnotes.
* **The Decision:** We utilize **Late-Binding Ranged Reads supported by Semi-Structured Persistence (Postgres JSONB / DuckDB)**. 
* **Why:** Preserves 100% of original document context and spatial coordinates. Downstream agents dynamically pull slices when needed without rigid schema migration lock-in.

### B. Ingestion Cadence & Processing Budget (Batch vs. Real-Time)
* **The Trade-off:** Sub-second real-time API latency versus deep structural extraction accuracy.
* **The Decision:** Designed for a **monthly/quarterly batch processing window**.
* **Why:** Because reports arrive periodically, we can afford a 30–90 second deep extraction, layout profiling, and validation check upfront. This cadence also makes **Human-in-the-Loop (HITL) review queues** viable for edge cases and schema drift before data lands in the gold layer.

### C. Deterministic Core vs. Agentic Escalation (The 90/10 Rule)
* **The Trade-off:** Relying entirely on generative LLMs/VLMs for tabular parsing is slow, expensive, and prone to hallucinations on numbers.
* **The Decision:** 
  * **90% Deterministic Core:** Uses high-speed Python/Rust tooling (DuckDB, `calamine`, PyMuPDF) for clean CSV streaming, ranged spreadsheet reads, and exact 64-bit float math.
  * **10% Agentic & VLM Escalation:** Reserved exclusively for ambiguous layouts, unmerging messy cells, and parsing unstructured footnotes.

### D. System One Control Layer (Jev Integration)
* **The Trade-off:** Heavy LLM prompt loops introduce high latency and token costs for basic routing tasks.
* **The Decision:** Uses **Jev** as a high-speed, deterministic control layer for pipeline routing, sheet classification, and calibrated confidence gating.
* **Why:** Provides typed, probabilistic outputs (`Choice`, `Score`) in milliseconds with zero prose overhead, routing files cleanly between the direct CSV path, sparse Excel profiler, and VLM visual pipelines.

---

## 3. High-Level Ingestion & Processing Flow

1. **Ingestion Gateway:** Unzips bundle, inspects MIME types, and registers raw files (Bronze layer).
2. **Unified Indexer (Step 1):** Maps structural boundaries. Sparse-row pre-pass scans Excel XML nodes or memory-mapped CSV bytes without loading empty cells.
3. **Deep Extraction & Normalization:** Format-specific workers parse ranged slices, unmerge cells, normalize accounting brackets (`(1,250)` $\rightarrow$ `-1250.00`), and standardize dates.
4. **Mathematical Reconciliation:** Automatically tests core accounting invariants before persistence:
   $$\text{Beginning Capital} + \text{Capital Calls} - \text{Distributions} \pm \text{Net Income} = \text{Ending Capital}$$
5. **Persistence & HITL Gating:** Verified data flows to Silver/Gold structured storage. Failures or low-confidence extractions are routed to an auditor review queue.