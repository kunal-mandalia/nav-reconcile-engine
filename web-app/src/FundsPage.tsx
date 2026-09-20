import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Search, ShieldCheck } from "lucide-react";
import { api, ApiError, IDENTITIES, type Identity } from "./api";
import { ErrorNotice, Loading, Rerun, Status } from "./components";
import { amount, time } from "./format";

export function FundsPage({ identity }: { identity: Identity }) {
  const [params, setParams] = useSearchParams();
  const filter = params.get("status") ?? "all";
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("q2");
  const query = useQuery({
    queryKey: ["funds", identity, period],
    queryFn: ({ signal }) => api.funds(identity, period, signal),
    refetchInterval: (q) => {
      if (
        !q.state.data?.funds.some((f) =>
          ["running", "queued"].includes(f.display_status),
        )
      )
        return false;
      return q.state.error instanceof ApiError && q.state.error.retryAfter > 0
        ? q.state.error.retryAfter * 1000
        : 2000;
    },
  });
  const funds = query.data?.funds ?? [];
  const attention = [
    "mismatch",
    "insufficient_evidence",
    "run_failed",
    "processing_failed",
    "awaiting_documents",
  ];
  const filtered = funds.filter(
    (f) =>
      `${f.name} ${f.administrator}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "attention"
          ? attention.includes(f.display_status)
          : filter === "running"
            ? ["running", "queued"].includes(f.display_status)
            : f.display_status === filter)),
  );
  const metrics: [string, number, string, string][] = [
    ["All funds", funds.length, "In this reporting period", "all"],
    [
      "Matched",
      funds.filter((f) => f.display_status === "matched").length,
      "Capital roll-forward within tolerance",
      "matched",
    ],
    [
      "Needs attention",
      funds.filter((f) => attention.includes(f.display_status)).length,
      "Mismatches, missing inputs & failures",
      "attention",
    ],
    [
      "Running",
      funds.filter((f) => ["running", "queued"].includes(f.display_status))
        .length,
      "Reconciliation in progress",
      "running",
    ],
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Portfolio oversight</div>
          <h1>Fund reconciliations</h1>
          <p>A clear view of every fund. Evidence behind every result.</p>
        </div>
        <div className="period-label">
          <span className="live-dot" />
          Quarter ending
          <br />
          <strong>{period === "q2" ? "30 Jun 2026" : "31 Mar 2026"}</strong>
        </div>
      </div>
      {query.error && (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      )}
      {query.isPending ? (
        <Loading />
      ) : query.data ? (
        <>
          <div className="metrics">
            {metrics.map(([name, value, note, status]) => (
              <button
                className={`metric ${filter === status ? "selected" : ""}`}
                key={name}
                onClick={() => setParams(status === "all" ? {} : { status })}
              >
                <span>
                  {name}
                  <i />
                </span>
                <strong>{String(value).padStart(2, "0")}</strong>
                <small>{note}</small>
              </button>
            ))}
          </div>
          <section className="panel" aria-label="Fund list">
            <div className="toolbar">
              <label className="search">
                <Search size={16} />
                <span className="sr-only">Search funds or administrators</span>
                <input
                  type="search"
                  placeholder="Search funds or administrators…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="filters">
                <label>
                  <span className="sr-only">Reporting period</span>
                  <select
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                  >
                    <option value="q2">Q2 2026 · 30 Jun</option>
                    <option value="q1">Q1 2026 · 31 Mar</option>
                  </select>
                </label>
                <label>
                  <span className="sr-only">Reconciliation status</span>
                  <select
                    value={filter}
                    onChange={(e) =>
                      setParams(
                        e.target.value === "all"
                          ? {}
                          : { status: e.target.value },
                      )
                    }
                  >
                    <option value="all">All statuses</option>
                    <option value="attention">Needs attention</option>
                    <option value="matched">Matched</option>
                    <option value="mismatch">NAV mismatch</option>
                    <option value="insufficient_evidence">Needs input</option>
                    <option value="run_failed">Run failed</option>
                    <option value="not_run">Not run</option>
                    <option value="running">Running / queued</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">
                  Fund reconciliations. Monetary values are in each fund's
                  currency.
                </caption>
                <thead>
                  <tr>
                    <th>Fund / administrator</th>
                    <th>Reconciliation</th>
                    <th className="right">Reported NAV</th>
                    <th className="right">Difference</th>
                    <th>Last run</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((f) => (
                    <tr key={f.fund_id}>
                      <td>
                        <div className="fund-cell">
                          <span className="monogram" aria-hidden="true">
                            {f.name[0]}
                          </span>
                          <div>
                            {f.latest_run_id ? (
                              <Link
                                className="fund-name"
                                to={`/runs/${f.latest_run_id}`}
                              >
                                {f.name}
                              </Link>
                            ) : (
                              <strong className="fund-name">{f.name}</strong>
                            )}
                            <div className="subtext">
                              {f.strategy} · {f.administrator}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <Status status={f.display_status} />
                        <div className="subtext">{f.status_reason}</div>
                      </td>
                      <td className="right num">
                        {f.reported_nav === null
                          ? "—"
                          : `${f.currency} ${amount(f.reported_nav)}`}
                        <div className="subtext">
                          {f.last_completed_run_id &&
                          f.latest_run_id !== f.last_completed_run_id
                            ? "Previous completed result"
                            : `Pack v${f.pack?.version ?? "—"}`}
                        </div>
                      </td>
                      <td
                        className={`right num ${f.display_status === "mismatch" ? "variance" : ""}`}
                      >
                        {amount(f.difference, true)}
                        <div className="subtext">
                          {f.difference === null
                            ? "Not calculated"
                            : f.currency}
                        </div>
                      </td>
                      <td>
                        {f.last_run_at ? `${time(f.last_run_at)} UTC` : "—"}
                        <div className="subtext">
                          {f.last_run_at ? "Latest attempt" : "Ready to start"}
                        </div>
                      </td>
                      <td>
                        <div className="row-actions">
                          <Rerun
                            identity={identity}
                            fundId={f.fund_id}
                            periodId={f.reconciliation_period_id}
                            fundName={f.name}
                            packVersion={f.pack?.version ?? 1}
                            allowed={f.can_rerun}
                            first={!f.latest_run_id}
                          />
                          {f.latest_run_id && (
                            <Link
                              className="btn"
                              to={`/runs/${f.latest_run_id}`}
                              aria-label={`View ${f.name}`}
                            >
                              View <ArrowRight size={13} />
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <div className="empty">
                <h2>
                  {funds.length
                    ? "No funds match these filters"
                    : "No reconciliations for this period"}
                </h2>
                <p>
                  {funds.length
                    ? "Try another name or clear the status filter."
                    : "The mock workspace has sample packs for Q2 2026."}
                </p>
                <button
                  className="btn"
                  onClick={() => {
                    setSearch("");
                    setParams({});
                    setPeriod("q2");
                  }}
                >
                  {funds.length ? "Clear filters" : "Return to Q2 2026"}
                </button>
              </div>
            )}
            <div className="table-footer">
              <span>
                Showing {filtered.length} of {funds.length} authorised funds
              </span>
              <span>
                Difference = calculated − reported NAV · Fund-level balances
              </span>
            </div>
          </section>
          <p className="footnote">
            “Matched” means the configured capital roll-forward checks pass. It
            is separate from human approval.
          </p>
          <div className="bottom-note">
            <ShieldCheck size={21} />
            <div>
              <strong>
                {IDENTITIES[identity].canRun
                  ? "Start with the exceptions"
                  : "Read-only demo identity"}
              </strong>
              <p>
                {IDENTITIES[identity].canRun
                  ? "Open a fund, inspect the decision and follow a citation to the exact source value."
                  : "Priya can see two assigned funds and inspect their evidence. Reconciliation actions require operations access."}
              </p>
              <small>
                Fictional sample packs · Fixed input layout · 0.01 tolerance ·
                No live fund service
              </small>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
