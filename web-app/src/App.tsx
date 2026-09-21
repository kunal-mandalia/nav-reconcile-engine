import { useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Layers, LayoutGrid, CircleAlert } from "lucide-react";
import { IDENTITIES, type Identity } from "./api";
import { dataSource } from "./data-source";
import { DataSourceIndicator } from "./DataSourceIndicator";
import { FundsPage } from "./FundsPage";
import { RunPage } from "./RunPage";

export default function App() {
  const [identity, setIdentity] = useState<Identity>(() =>
    localStorage.getItem("nav-demo-identity") === "reviewer"
      ? "reviewer"
      : "operations",
  );
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  function changeIdentity(next: Identity) {
    void client.cancelQueries();
    client.clear();
    dataSource.reset();
    localStorage.setItem("nav-demo-identity", next);
    setIdentity(next);
    navigate("/");
  }
  return (
    <>
      <div className="demo-bar">
        <strong>Interactive demo</strong>
        <span>Fictional sample packs</span>
      </div>
      <div className="shell">
        <aside className="sidebar">
          <Link className="brand" to="/">
            <span className="brand-mark">
              <i />
              <i />
              <i />
            </span>
            Ledger<small>/ NAV</small>
          </Link>
          <div className="workspace">
            <strong>Northstar Investments</strong>
            <span>Private markets · Operations</span>
          </div>
          <nav aria-label="Workspace">
            <div className="eyebrow">Workspace</div>
            <Link
              className={
                location.search !== "?status=attention" ? "active" : ""
              }
              to="/"
            >
              <LayoutGrid size={16} />
              Funds
            </Link>
            <Link
              className={
                location.search === "?status=attention" ? "active" : ""
              }
              to="/?status=attention"
            >
              <CircleAlert size={16} />
              Needs attention
            </Link>
          </nav>
          <div className="sidebar-bottom">
            <div className="person">
              <span className="avatar">{IDENTITIES[identity].initials}</span>
              <div>
                <strong>
                  {identity === "operations" ? "Alex Chen" : "Priya Shah"}
                </strong>
                <small>
                  {identity === "operations"
                    ? "Fund operations"
                    : "Read-only reviewer"}
                </small>
              </div>
            </div>
            <p>Quarter-end, with confidence.</p>
          </div>
        </aside>
        <main>
          <header className="topbar">
            <div className="breadcrumb">
              <span>Private markets</span>
              <span>/</span>
              <Link to="/">Funds</Link>
              {location.pathname.startsWith("/runs/") && (
                <>
                  <span>/</span>
                  <span>Reconciliation</span>
                </>
              )}
            </div>
            <DataSourceIndicator />
            <label className="identity-select">
              <span>Demo identity</span>
              <select
                aria-label="Demo identity"
                value={identity}
                onChange={(e) => changeIdentity(e.target.value as Identity)}
              >
                {Object.entries(IDENTITIES).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value.label}
                  </option>
                ))}
              </select>
            </label>
          </header>
          <div className="content" key={identity}>
            <Routes>
              <Route path="/" element={<FundsPage identity={identity} />} />
              <Route
                path="/runs/:runId"
                element={<RunPage identity={identity} />}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
          <footer className="app-footer">
            <Layers size={12} />
            <span>
              Fixed layouts · Deterministic decisions · Amounts preserve decimal
              precision
            </span>
          </footer>
        </main>
      </div>
    </>
  );
}
