import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  FileText,
  LoaderCircle,
} from "lucide-react";
import type { CompletedRun, Fact, FactField, Run } from "@nav/contracts";
import { api, ApiError, IDENTITIES, type Identity } from "./api";
import {
  Dialog,
  DownloadSource,
  ErrorNotice,
  Loading,
  Rerun,
  Status,
} from "./components";
import { amount, date, location, time } from "./format";

const fields: [FactField, string, string][] = [
  ["opening_nav", "Opening capital", ""],
  ["capital_calls", "Capital calls", "+"],
  ["distributions", "Distributions", "−"],
  ["net_income", "Net income / (loss)", "+"],
];
const stages = [
  "waiting",
  "extracting",
  "normalising",
  "reconciling",
  "publishing",
  "finished",
];
const stageLabels: Record<string, string> = {
  waiting: "Waiting to start",
  extracting: "Extracting source values",
  normalising: "Normalising amounts",
  reconciling: "Checking the roll-forward",
  publishing: "Preparing decision and evidence",
  finished: "Complete",
};

function Evidence({
  run,
  fact,
  identity,
  close,
}: {
  run: CompletedRun;
  fact: Fact;
  identity: Identity;
  close: () => void;
}) {
  const source = run.sources.find((s) => s.document_id === fact.document_id)!;
  return (
    <Dialog title="Source evidence" close={close}>
      <div className="dialog-body">
        <div className="eyebrow">
          Decision provenance · pack v{run.inputs.pack_version}
        </div>
        <h3 className="source-filename">{source.filename}</h3>
        <p>
          {location(fact)} · {run.inputs.currency} · actual units
        </p>
        <div className="source-preview">
          <span className="eyebrow">{fact.field.replaceAll("_", " ")}</span>
          <div className="source-values">
            <div>
              <span>Original value</span>
              <strong>{fact.raw_text}</strong>
            </div>
            <div>
              <span>Normalised amount · {fact.currency}</span>
              <strong>{amount(fact.amount)}</strong>
            </div>
          </div>
        </div>
        <div className="normalisation">
          <h3>How this value was used</h3>
          {fact.normalisation_steps.map((step, i) => (
            <p key={i}>
              <Check size={13} />
              {step.operation.replaceAll("_", " ")}
              {step.output && <span className="num">{step.output}</span>}
            </p>
          ))}
        </div>
        <p className="demo-note">
          This excerpt and the downloadable CSV come from the same fictional
          source fixture. CSV record numbers exclude the header. The run keeps
          its own immutable evidence.
        </p>
      </div>
      <div className="dialog-foot">
        <DownloadSource identity={identity} source={source} />
        <button className="btn" onClick={close}>
          Back to reconciliation
        </button>
      </div>
    </Dialog>
  );
}
function Decision({ run }: { run: Run }) {
  if (run.state === "failed")
    return (
      <>
        <h2>This run stopped before a NAV decision</h2>
        <p>{run.error.message}</p>
        <small>
          {run.error.code} · No financial mismatch has been established.
        </small>
      </>
    );
  if (run.state !== "completed")
    return (
      <>
        <h2>
          {run.state === "queued"
            ? "Reconciliation queued"
            : "Reconciliation in progress"}
        </h2>
        <p>
          Checking pack v{run.inputs.pack_version} for{" "}
          {date(run.inputs.period_end)}. Earlier results remain unchanged.
        </p>
        <ol className="progress-steps" aria-label="Reconciliation progress">
          {stages.slice(0, 5).map((stage, index) => (
            <li
              className={stages.indexOf(run.stage) >= index ? "current" : ""}
              key={stage}
            >
              <span />
              {
                ["Queued", "Extract", "Normalise", "Reconcile", "Publish"][
                  index
                ]
              }
            </li>
          ))}
        </ol>
        <div role="status" className="stage-label">
          {stageLabels[run.stage]}
        </div>
      </>
    );
  return (
    <>
      <h2>
        {run.outcome === "matched"
          ? "Capital roll-forward matched"
          : run.outcome === "insufficient_evidence"
            ? "More evidence is needed to reconcile this fund"
            : `Calculated NAV is ${run.inputs.currency} ${amount(run.summary.difference?.replace("-", ""))} ${run.summary.difference?.startsWith("-") ? "below" : "above"} the reported balance`}
      </h2>
      <p>{run.commentary.find((c) => c.kind === "finding")?.text}</p>
    </>
  );
}
export function RunPage({ identity }: { identity: Identity }) {
  const { runId = "" } = useParams();
  const client = useQueryClient();
  const [tab, setTab] = useState<"overview" | "sources">("overview");
  const [factId, setFactId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["run", identity, runId],
    queryFn: ({ signal }) => api.run(identity, runId, signal),
    refetchInterval: (q) => {
      if (
        q.state.data?.state === "completed" ||
        q.state.data?.state === "failed"
      )
        return false;
      if (
        q.state.error instanceof ApiError &&
        [401, 403, 404, 422].includes(q.state.error.status)
      )
        return false;
      return q.state.error instanceof ApiError && q.state.error.retryAfter > 0
        ? q.state.error.retryAfter * 1000
        : Math.min(30000, 2000 * 2 ** q.state.fetchFailureCount);
    },
  });
  const run = query.data;
  useEffect(() => {
    if (run?.state === "completed" || run?.state === "failed")
      void client.invalidateQueries({ queryKey: ["funds", identity] });
  }, [run?.state, runId, identity, client]);
  useEffect(() => {
    setFactId(null);
    setTab("overview");
  }, [runId, identity]);
  const completed = run?.state === "completed" ? run : null;
  const fact = completed?.facts.find((f) => f.fact_id === factId);
  const status =
    run?.state === "completed"
      ? run.outcome
      : run?.state === "failed"
        ? "run_failed"
        : (run?.state ?? "queued");
  const citation = (id: string) => {
    const n = completed!.facts.findIndex((f) => f.fact_id === id) + 1;
    return (
      <button
        className="citation"
        key={id}
        onClick={() => setFactId(id)}
        aria-label={`View source evidence ${n}`}
      >
        {n}
      </button>
    );
  };
  return (
    <>
      <Link className="back" to="/">
        <ArrowLeft size={14} />
        All funds
      </Link>
      {query.error && (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      )}
      {query.isPending && <Loading message="Loading reconciliation…" />}
      {run && (
        <>
          <div className="page-heading detail-heading">
            <div>
              <div className="eyebrow">Fund reconciliation</div>
              <h1>{run.fund.name}</h1>
              <div className="subtitle">
                {run.fund.strategy}
                <span>·</span>
                {run.fund.administrator}
                <span>·</span>
                {run.inputs.currency}
                <Status status={status} />
              </div>
            </div>
            <Rerun
              identity={identity}
              fundId={run.fund.fund_id}
              periodId={run.reconciliation_period_id}
              fundName={run.fund.name}
              packVersion={run.inputs.pack_version}
              allowed={
                IDENTITIES[identity].canRun &&
                ["completed", "failed"].includes(run.state)
              }
            />
          </div>
          <section
            className={`decision ${status}`}
            aria-label="Reconciliation decision"
          >
            <span className="decision-icon">
              {status === "matched" ? (
                <Check size={19} />
              ) : ["queued", "running"].includes(status) ? (
                <LoaderCircle className="spin" size={19} />
              ) : (
                <CircleAlert size={19} />
              )}
            </span>
            <div>
              <Decision run={run} />
              {completed && (
                <div className="decision-citations">
                  <span>Supporting evidence</span>
                  {completed.facts.map((f) => citation(f.fact_id))}
                </div>
              )}
            </div>
          </section>
          <div className="detail-grid">
            <div className="main-stack">
              {completed ? (
                <>
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="Reconciliation detail"
                  >
                    {(["overview", "sources"] as const).map((value) => (
                      <button
                        key={value}
                        role="tab"
                        id={`tab-${value}`}
                        aria-selected={tab === value}
                        aria-controls="detail-panel"
                        tabIndex={tab === value ? 0 : -1}
                        className={tab === value ? "selected" : ""}
                        onClick={() => setTab(value)}
                        onKeyDown={(e) => {
                          if (
                            ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                              e.key,
                            )
                          ) {
                            e.preventDefault();
                            const next =
                              e.key === "Home"
                                ? "overview"
                                : e.key === "End"
                                  ? "sources"
                                  : value === "overview"
                                    ? "sources"
                                    : "overview";
                            setTab(next);
                            document.getElementById(`tab-${next}`)?.focus();
                          }
                        }}
                      >
                        {value === "overview"
                          ? "Overview"
                          : `Sources · ${completed.sources.length}`}
                      </button>
                    ))}
                  </div>
                  <div
                    id="detail-panel"
                    role="tabpanel"
                    aria-labelledby={`tab-${tab}`}
                    className="main-stack"
                  >
                    {tab === "overview" ? (
                      <>
                        <section className="panel">
                          <div className="panel-heading">
                            <h2>Capital roll-forward</h2>
                            <span>{run.inputs.currency} · actual units</span>
                          </div>
                          <div className="calculation">
                            {fields.map(([field, label, op]) => {
                              const f = completed.facts.find(
                                (f) => f.field === field,
                              );
                              return (
                                <div className="calc-row" key={field}>
                                  <span>
                                    <i>{op}</i>
                                    {label}
                                    {field === "opening_nav" && (
                                      <small>31 Mar 2026</small>
                                    )}
                                  </span>
                                  <strong title={f?.amount}>
                                    {amount(f?.amount)}
                                  </strong>
                                  {f ? (
                                    citation(f.fact_id)
                                  ) : (
                                    <span className="muted">?</span>
                                  )}
                                </div>
                              );
                            })}
                            <div className="calc-row total">
                              <span>Calculated closing NAV</span>
                              <strong>
                                {amount(completed.summary.calculated_nav)}
                              </strong>
                            </div>
                            <div className="calc-row">
                              <span>Reported closing NAV</span>
                              <strong>
                                {amount(completed.summary.reported_nav)}
                              </strong>
                              {completed.facts
                                .filter((f) => f.field === "reported_nav")
                                .map((f) => citation(f.fact_id))}
                            </div>
                            <div
                              className={`calc-row difference ${completed.outcome}`}
                            >
                              <span>Difference</span>
                              <strong>
                                {amount(completed.summary.difference, true)}
                              </strong>
                            </div>
                          </div>
                          <div className="panel-footer">
                            Pass condition: absolute difference ≤{" "}
                            {run.inputs.currency}{" "}
                            {amount(run.inputs.absolute_tolerance)}. Missing
                            values are never zero.
                          </div>
                        </section>
                        <section className="panel">
                          <div className="panel-heading">
                            <h2>Checks performed</h2>
                            <span>
                              {
                                completed.checks.filter(
                                  (c) => c.status === "pass",
                                ).length
                              }{" "}
                              of {completed.checks.length} pass
                            </span>
                          </div>
                          <div className="checks">
                            {completed.checks.map((check) => (
                              <div className="check-row" key={check.check_id}>
                                <div>
                                  <strong>
                                    {check.type === "input_alignment"
                                      ? "Period, entity & currency alignment"
                                      : "Capital roll-forward"}
                                  </strong>
                                  <small>
                                    {check.reason_code
                                      ? check.reason_code
                                          .replaceAll("_", " ")
                                          .toLowerCase()
                                      : check.type === "input_alignment"
                                        ? `${date(run.inputs.period_end)} · whole fund · ${run.inputs.currency}`
                                        : "Balances agree within tolerance"}
                                  </small>
                                </div>
                                <span className={`check-state ${check.status}`}>
                                  {check.status === "pass"
                                    ? "✓ Pass"
                                    : check.status === "fail"
                                      ? "! Mismatch"
                                      : "Not evaluated"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </section>
                      </>
                    ) : (
                      <section className="panel">
                        <div className="panel-heading">
                          <h2>Documents behind this decision</h2>
                        </div>
                        {completed.sources.map((source) => (
                          <div className="source-card" key={source.document_id}>
                            <FileText size={25} />
                            <div>
                              <h3>{source.filename}</h3>
                              <p>
                                {completed.facts
                                  .filter(
                                    (f) => f.document_id === source.document_id,
                                  )
                                  .map((f) => location(f))
                                  .join(" · ")}
                              </p>
                              <div className="source-facts">
                                {completed.facts
                                  .filter(
                                    (f) => f.document_id === source.document_id,
                                  )
                                  .map((f) => (
                                    <button
                                      className="text-link"
                                      onClick={() => setFactId(f.fact_id)}
                                      key={f.fact_id}
                                    >
                                      {f.field.replaceAll("_", " ")} ↗
                                    </button>
                                  ))}
                              </div>
                            </div>
                            <DownloadSource
                              identity={identity}
                              source={source}
                            />
                          </div>
                        ))}
                      </section>
                    )}
                  </div>
                </>
              ) : (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      {run.state === "failed"
                        ? "Processing exception"
                        : "Preparing the result"}
                    </h2>
                  </div>
                  <div className="panel-body">
                    <p>
                      {run.state === "failed"
                        ? "This is a technical failure, not a financial mismatch. The mock is configured to reproduce this failure on retry so you can inspect the error flow."
                        : "Calculations and source references appear together when processing finishes. You can return to the fund list while this runs."}
                    </p>
                    <Link to="/" className="text-link">
                      Return to fund list →
                    </Link>
                  </div>
                </section>
              )}
            </div>
            <aside className="detail-aside">
              <section className="panel">
                <div className="panel-heading">
                  <h2>Next action</h2>
                </div>
                <div className="panel-body">
                  <p>
                    {completed?.commentary.find((c) => c.kind === "next_action")
                      ?.text ??
                      (run.state === "failed"
                        ? "Inspect the error and retry when the underlying issue is resolved."
                        : "Wait for this run to finish. The result will update automatically.")}
                  </p>
                  <div className="review-note">
                    <span className="eyebrow">Human review</span>
                    <strong>
                      {completed ? "Unreviewed" : "Awaiting a decision"}
                    </strong>
                    <small>Review and sign-off are outside this demo.</small>
                  </div>
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Run context</h2>
                </div>
                <dl className="meta">
                  {[
                    ["Run", run.run_id.slice(0, 8)],
                    ["Reporting date", date(run.inputs.period_end)],
                    ["Entity scope", "Whole fund"],
                    ["Currency", run.inputs.currency],
                    ["Pack version", `v${run.inputs.pack_version}`],
                    [
                      "Tolerance",
                      `${run.inputs.currency} ${amount(run.inputs.absolute_tolerance)}`,
                    ],
                    ["Started", `${time(run.created_at)} UTC`],
                    ["Rule", run.inputs.ruleset_version],
                  ].map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <p className="scope-note">
                Coverage: capital roll-forward and input alignment. This does
                not verify underlying investment valuations.
              </p>
            </aside>
          </div>
          {completed && fact && (
            <Evidence
              identity={identity}
              run={completed}
              fact={fact}
              close={() => setFactId(null)}
            />
          )}
        </>
      )}
    </>
  );
}
