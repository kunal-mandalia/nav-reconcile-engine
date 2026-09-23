# Agent implementation: whole-file first

This is the implemented first slice of the [agent proposal](../proposals/agent-workflow.html). The interview scope deliberately uses naive whole-file tools. Document indexing, TOC navigation, cropped images and ranged reads remain future work.

## Run the demo

Set these values in the ignored root `.env`:

```dotenv
CLIENT_API_BACKEND=fund-service
AGENT_MODE=assist
AGENT_MODEL=openai:gpt-4.1-mini
OPENAI_API_KEY=your-api-key
SEED_AGENT_DEMO=true
```

Run `npm run docker:up` and open http://127.0.0.1:3005. Select **Harbor Infrastructure III → Start reconciliation**. Its whole-fund Q2 2026 pack has a messy CSV and four-page searchable PDF. The expected calculated NAV is USD 87,775,000, reported NAV USD 87,700,000 and difference USD 75,000. No source explains the variance.

The fund list labels how **new** runs will execute. Each run's context records its actual mode, model, verification result and call counts. Existing results keep their original mode. Original source downloads still use the existing authorised endpoint.

Set `AGENT_MODE=off` and rerun `npm run docker:up` for deterministic-only processing. The original six CSV packs use the existing parser. Harbor's layout is intentionally unsupported in that parser and produces Needs input, rather than silently invoking a model. `SEED_AGENT_DEMO` only controls registration; disabling it does not delete an already registered fund or its history. The TypeScript mock remains a separate `CLIENT_API_BACKEND=mock` mode and never invokes the Python agent.

The API key is passed only to the fund-service container, never to React, Express, the frozen policy or the audit. Startup fails clearly when assist is enabled without a key. API requests occur on explicit reconciliation runs; initial demo seeding always uses the deterministic path. OpenAI API billing is separate from ChatGPT billing.

## Implemented workflow

1. Admission freezes source hashes, rules and the non-secret agent policy in the existing run snapshot. Idempotent retries return the same run.
2. The existing Python worker runs a Pydantic AI interpreter. Its only tools are `list_files()` and `read_file(document_id)`. IDs must belong to the frozen manifest; there are no arbitrary paths, external fetches, SQL, write or delegation tools.
3. `read_file` returns the entire CSV as numbered logical records, or the entire PDF as numbered text words with coordinates plus all full-page images. This is source addressing, not a document index or ranged read. Original bytes are hash-checked. Nothing is silently truncated.
4. Typed candidates cite individual cells/words. Known-layout validators check the cited raw value, field, current column, fund, period, currency and scale. They reread every fixed-layout CSV row to detect omitted conflicting values. The administrator CSV/PDF adapters support the supplied Harbor format; they do not claim to understand arbitrary layouts. All relevant sources must contribute readings. One schema/coverage repair per role is allowed within the same budget.
5. For a PDF pack, a separate blinded call reads the original full-page images without the interpreter's numbers or extracted text. Python checks scope and compares all five amounts exactly after normalisation. CSV-only legacy packs use deterministic source checks and are labelled accordingly, never as visually verified.
6. The existing Decimal engine calculates the roll-forward. Extraction agreement allows zero numerical deviation; reconciliation retains its separate USD 0.01 tolerance.
7. A tool-free commentator returns a constrained claim plan, outcome and citations. Python validates the plan and renders established exact wording. Free-form causal explanations are deliberately excluded. A commentary error falls back to the deterministic template.
8. Accepted facts/checks/results and the bounded audit publish in one database transaction. Failed runs retain diagnostics without publishing a financial conclusion. No model call holds a database transaction open.

Shared models and source documents can produce correlated errors. Agreement is a verification gate, not proof of accuracy. The synthetic CSV and PDF derive from the same fixture constants; this is a reproducible workflow test, not independent ground truth from two administrators.

## Limits and errors

| Control | Default / ceiling |
| --- | --- |
| Model attempts | 12 shared across roles; interpreter 6, verifier 4, commentator 2 |
| Tool calls | 24 attempted calls, including invalid/unknown calls; oversize batches are rejected before execution |
| Provider retries | Disabled in the OpenAI transport; schema/coverage repairs consume model attempts |
| Deadline | 90 seconds for the workflow, 20 seconds per model request; configurable up to 180 / 60 seconds |
| Output | At most 4,000 tokens per response; cumulative usage limit 12,000 output / 40,000 input tokens |
| File bytes | 2 MB per source |
| CSV size | 500 logical records per file |
| Text | 40,000 serialised characters across the pack |
| PDFs | Six pages across the pack, unrotated, at most 1,200 points per dimension; rendered at scale 1.5 |
| PDF image bytes | 8 MB per file |

Settings: `AGENT_MAX_REQUESTS`, `AGENT_MAX_TOOL_CALLS`, `AGENT_TIMEOUT_SECONDS`, `AGENT_REQUEST_TIMEOUT_SECONDS`. Counters include attempts before successful provider responses. Token totals are provider-reported and checked after responses, so they are not hard billing guarantees. There are no agent-created subworkflows or recursive calls. The container shutdown grace period accommodates the bounded worker.

- Invalid/ambiguous citations, missing evidence, conflicting sources, or differing visual readings: `completed / insufficient_evidence`. No disputed amounts enter the financial result.
- Oversized files: `failed / WHOLE_FILE_LIMIT` with an explicit ranged-read limitation. Image-only scans and unsupported PDF geometry require a later policy.
- Timeout, unavailable provider or exhausted extraction budget: `failed`, never a silent switch to deterministic processing.
- Commentary failure: retain the verified result and use the template.
- Restart: unfinished runs fail with the existing `PROCESS_INTERRUPTED` behavior; no automatic paid replay.

## Persistence and contracts

Migration `002_agent_trace.sql` adds `reconciliation_run.agent_trace` JSONB. It records bounded model/tool attempt events, parsed candidate and visual outputs, validation issues, usage and fallback status. It stores neither API credentials nor image payloads or hidden chain-of-thought. Original file hashes/coordinates remain the evidence. Completed and failed audits are inspectable in Postgres; an interrupted process may not have flushed its in-memory trace.

The four API operations remain. Additive shared-schema fields are `FundList.processing_mode` and `Run.processing`. Fields are optional for compatibility with the existing mock. The `csv_record` locator (version 1) counts one-based logical records across the entire file, including headers and preambles. The original `csv.record_number` convention is unchanged.

## Tests and live evaluation

```sh
npm run test:fund
npm test
npm run typecheck
PLAYWRIGHT_CHROME_CHANNEL=chrome npm run test:agent:e2e
npm run eval:agent -- --live --report /tmp/nav-agent-report.json
```

Python tests disable real model requests globally and use Pydantic AI `FunctionModel` responses with real readers and a separate Postgres database. They cover baseline/matched/conflicting packs, visual disagreement, invalid citations, budgets, provider failures, commentary fallback, immutable mode snapshots, evidence downloads and idempotency. The browser harness creates a disposable database and starts the real worker, Express and React on ports 8105/4105/3105, with scripted providers. It cleans up its own services and database and leaves the running demo alone.

The opt-in live evaluation uses only the fictional source allowlist, stores sources temporarily, compares all five accepted values with an oracle outside model context, and writes no demo database data. A successful OpenAI evaluation on 24 September 2026 used six requests and three tool calls, with all five values verified and the expected USD 75,000 mismatch. Earlier development attempts were rejected for omitted PDF citations and output-format mismatches; the schema/coverage corrections are part of this implementation. One successful fixture run does not establish general extraction reliability.

## Interview extension: index → ranged reads

`RangedReaderPlaceholder` is intentionally **not registered as a model tool**. Implement it later by adding a structural document index, section IDs, bounded CSV record intervals and PDF crops with heading/unit/footnote context. Preserve the same scoped manifest, exact-money gate and provenance contracts. Compare input tokens, latency and extraction accuracy against this whole-file baseline on larger held-out packs.

Pydantic AI and the domain workflow are provider-neutral, but this slice wires and validates only `openai:<model>`. GPT-4.1 mini accepts images, tools and structured outputs. A Gemini adapter (and optionally a separate visual model setting) can be added without moving accounting rules into prompts; it must pass the same tests, disable or account for transport retries, and retain shared budgets.

References: [Pydantic AI limits](https://pydantic.dev/docs/ai/core-concepts/agent/#usage-limits), [scripted-model testing](https://pydantic.dev/docs/ai/guides/testing/), [OpenAI model capabilities](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Pydantic AI Google adapter](https://pydantic.dev/docs/ai/models/google/).
