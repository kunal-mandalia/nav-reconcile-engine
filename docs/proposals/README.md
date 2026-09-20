# NAV reconciliation UX proposal

Open [nav-reconciliation-ux.html](nav-reconciliation-ux.html) directly in a browser. It is a self-contained proposal: no server, installation, external assets or network connection is required.

## Try the core journey

1. Browse the six fictional funds; search or filter by reconciliation status.
2. Open **Atlas Growth Fund IV** for a mismatch, or **Meridian Infrastructure II** for a match.
3. Read the decision commentary and capital roll-forward. Click a numbered citation to inspect the source location, original value and normalisation explanation.
4. Explore **Sources** and **Run history**.
5. Select **Rerun reconciliation**, check the pack and rule context, then start the simulated run. The outcome remains unchanged because the inputs are unchanged; a new history entry is added.
6. Open **Oakbridge** for missing-document handling and **Summit** for a processing failure. Select Q1 to see an empty reporting period.

Search, filters, detail tabs, source previews, simulated reruns and filtered CSV export work. Data is fictional and resets on refresh. Upload and review buttons explain proposed workflows; they do not upload documents or approve results. “Ledger” is a provisional product label.

## Planned application integration

The agreed demo architecture is **React → Node.js/Express client API → Python/FastAPI reconciliation service → DuckDB and local files**. The HTML proposal remains a standalone visual reference, not a running implementation of this stack.

Express will centralise user authentication, fund-level authorisation, rate limiting, request validation and request IDs. FastAPI will remain internal, authenticate the calling service and own document processing, reconciliation and persistence. React will access results and source evidence through Express, including while polling a running reconciliation.

The first demo will use clearly labelled mock identity and basic rate limiting. The React implementation should show access-denied, retry-after and service-unavailable feedback; these states are not yet simulated in the HTML proposal. Production identity integration and distributed rate limits are interview discussion topics. See the [implementation plan](../plans/provisional.md) for scope and verification steps.

## User needs beyond the initial brief

- **Reporting context:** Period, entity scope, base currency, units, pack version and agreed tolerance must be visible alongside each decision.
- **Intake and revisions:** Users need to upload packs, see missing documents, identify duplicates and distinguish revised packs. Results should be marked stale when inputs change.
- **Actionable states:** A mismatch, incomplete input, processing failure and active run require different next steps. A mathematical match must remain separate from reviewer approval.
- **Exception resolution:** Assign an owner, record investigation notes, request corrections and explicitly accept or resolve an exception without erasing the original discrepancy.
- **Evidence and history:** Preserve original files, exact source locations, normalisation steps, immutable run results and reviewer actions. Allow inspection and comparison of past runs.
- **Handover:** Share links to a specific result, export an evidence package and notify users when long-running work completes.
- **Permissions:** Define who may upload, rerun, correct inputs, change tolerances and sign off a period.

The proposal's **Scope & UX gaps** dialog also contains these considerations, with labels distinguishing demonstrated and future workflows.

## Decisions to settle before implementation

- Which comparisons define “NAV reconciled” beyond the initial capital roll-forward? The concept illustrates three checks; it does not validate investment valuations or all trial-balance relationships.
- Is the primary reconciliation entity a whole fund, share class or investor capital account?
- Who defines tolerances, owns exceptions and approves the reporting period?
- Which source document takes precedence when administrator statements disagree?

The capital roll-forward, tolerance, example checks and review roles are UX assumptions for discussion, not final business rules. Source excerpts demonstrate the evidence interaction; production should open the actual document at its cited location.
