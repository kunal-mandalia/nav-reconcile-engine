import { useSyncExternalStore } from "react";

type DataSource = "mock" | "fund-service";
type Connection = {
  source: DataSource | null;
  status: "checking" | "connected" | "disconnected" | "unverified";
};
let state: Connection = { source: null, status: "checking" };
let sequence = 0;
let applied = 0;
const listeners = new Set<() => void>();
function update(ticket: number, next: Connection) {
  // An older in-flight response must not overwrite a newer observation.
  if (ticket < applied) return;
  applied = ticket;
  state = next;
  listeners.forEach((listener) => listener());
}
export const dataSource = {
  begin: () => ++sequence,
  confirm(ticket: number, header: string | null) {
    const source =
      header === "mock" || header === "fund-service" ? header : null;
    update(ticket, { source, status: source ? "connected" : "unverified" });
  },
  fail(ticket: number) {
    update(ticket, { ...state, status: "disconnected" });
  },
  reset() {
    update(++sequence, { source: null, status: "checking" });
  },
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
export function useDataSource() {
  return useSyncExternalStore(dataSource.subscribe, dataSource.getSnapshot);
}
