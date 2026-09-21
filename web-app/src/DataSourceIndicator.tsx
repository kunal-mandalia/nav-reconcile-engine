import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDataSource } from "./data-source";

export function DataSourceIndicator() {
  const connection = useDataSource();
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(listener),
    [cache],
  );
  const snapshot = useCallback(
    () =>
      cache
        .getAll()
        .some(
          (query) =>
            query.getObserversCount() > 0 && query.state.data !== undefined,
        ),
    [cache],
  );
  const hasVisibleData = useSyncExternalStore(subscribe, snapshot);
  let label = "Checking connection…";
  let detail = "Waiting for an API response";
  let tone = "neutral";
  if (connection.status === "connected") {
    const persisted = connection.source === "fund-service";
    label = persisted
      ? "Fund service · persisted data"
      : "Mock · temporary data";
    detail = persisted ? "FastAPI + Postgres" : "Resets when Express restarts";
    tone = persisted ? "service" : "mock";
  } else if (connection.status === "disconnected") {
    label = hasVisibleData
      ? "Disconnected · cached data"
      : "Disconnected · no data loaded";
    detail = hasVisibleData
      ? "Showing previously loaded results"
      : "Retry the request to reconnect";
    tone = "disconnected";
  } else if (connection.status === "unverified") {
    label = "Data source unverified";
    detail = "API did not identify its data source";
  }
  return (
    <div
      className={`data-source ${tone}`}
      role="status"
      aria-label="Data source"
      title="Based on the latest API response; connection failures appear when a request fails."
    >
      <span>{label}</span>
      <small>{detail}</small>
    </div>
  );
}
