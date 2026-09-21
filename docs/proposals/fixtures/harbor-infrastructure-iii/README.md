# Harbor Infrastructure III — proposed agent fixture pack

These are fictional source artifacts for the [agent workflow proposal](../../agent-workflow.html). They are **not registered in the running fund service**, and the current fixed-layout CSV parser is not expected to process them successfully. PDF/agent processing remains proposed.

- Fund: **Harbor Infrastructure III**, reserved fixture UUID `00000000-0000-4000-8000-000000000007`.
- Whole-fund scope; 1 April–30 June 2026; USD; all source monetary figures in **thousands**.
- Canonical opening NAV `84000000.000000`, calls `6250000.000000`, distributions `2100000.000000`, signed net income `-375000.000000`.
- Calculated NAV `87775000.000000`. Baseline reported NAV `87700000.000000`: difference **+75000.000000**, outcome **mismatch**.
- Reconciliation tolerance `0.010000`; extraction agreement tolerance `0.000000`.

## Scenarios

| Scenario | Only source files to expose to the agent | Expected |
| --- | --- | --- |
| Baseline | `capital_account_messy.csv`, `quarterly_report.pdf` | `mismatch`, +75000.000000 |
| Matched | `capital_account_matched.csv`, `quarterly_report_matched.pdf` | `matched`, 0.000000 |
| Conflicting sources | `capital_account_messy.csv`, `quarterly_report_conflict.pdf` | `insufficient_evidence`; conflicting reported NAV; no selected reported NAV, calculated NAV or difference |
| Injected visual error | Baseline files, with a scripted verifier returning `87,701` thousand | `insufficient_evidence`; text/image discrepancy; no published numerical conclusion |

The final case is a **scripted model-output test**, not a corrupted PDF or a measured VLM result. Financial mismatch and extraction disagreement are different outcomes. See `expected.json` for exact facts, locations and expectations.

## File structure and locators

The UTF-8 BOM CSVs contain CRLF record separators, irregular row widths, preamble metadata, blank records, historical and investor-only decoys, repeated headings and a quoted multiline note. Parse logical records, not physical lines. Oracle `csv.record_index` is **one-based across the entire file including all preamble records**. The main data values are records 13–17, column 2; current-table header is record 12; units are record 5. This indexing is deliberately distinct from the current API's fixed-layout CSV `record_number`, which counts data records after its header. Introduce a versioned locator before integration; do not silently reuse that field.

Every PDF is four searchable pages with bookmarks and linked contents. Page 3 contains the capital schedule with current/prior columns; page 2 has a prior-period and investor-scope decoy. The exact bounding boxes in `expected.json` use original PDF points with a top-left origin. The proposed context region `[40, 140, 572, 585]` contains whole-fund scope, period/currency/scale headings, the full schedule and sign-convention notes. The fund name sits above this region and must accompany the read as page context or an expanded crop. Preview PNGs are renders of the actual PDF bytes, not illustrations or model-generated images.

No document supplies a cause for the baseline variance. Commentary must not invent one. CSV-rendered imagery is not independent source truth; use PDF/text and CSV/PDF agreement as defined in the proposed policy.

## Generation and validation

From the repository root:

```sh
uv run docs/proposals/fixtures/harbor-infrastructure-iii/generate.py
```

The script has pinned isolated dependencies and does not change the application's dependency files. It generates the CSVs/PDFs/previews, checks the five baseline values against PDF text and CSV records, records exact locators, verifies the known Decimal roll-forward, and writes SHA-256 hashes/lengths to `manifest.json`. ReportLab uses invariant metadata for reproducibility. Artifact checks are **not a model evaluation**.

`expected.json` is an explicit test oracle, separate from any agent extraction logic. **Never expose expected.json, manifest test metadata, README, generator, or proposal text to model tools.** Future test seeds should allowlist just the two source filenames for their scenario, use an isolated database and explicitly grant access to the new fund. Do not modify the existing six immutable seed packs. Do not give all scenario variants to one run.

Ordinary integration/E2E tests should use the real reader/storage/worker with scripted model responses. Opt-in live evaluations should compare repeated model runs to the same oracle and report extraction errors, unsupported claims, abstentions, latency and usage. More adversarial/held-out layouts are needed beyond these initial scenarios.
