import { createApp } from "./app.js";
import { MockFundService } from "./service.js";
import { RemoteFundService } from "./remote-service.js";

import { backendMode } from "./config.js";

const mock = backendMode(process.argv.slice(2), process.env) === "mock";
function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(
      "Port, timing and limit settings must be positive integers.",
    );
  return parsed;
}
const port = positive(process.env.PORT, 4700);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp({
  service: mock
    ? new MockFundService({
        stageMs: positive(process.env.MOCK_STAGE_MS, 1000),
      })
    : new RemoteFundService({
        url: process.env.FUND_SERVICE_URL ?? "http://127.0.0.1:4701",
        token: process.env.FUND_SERVICE_TOKEN ?? "",
        timeoutMs: positive(process.env.FUND_SERVICE_TIMEOUT_MS, 10000),
      }),
  runLimit: positive(process.env.RUN_RATE_LIMIT, 6),
  readLimit: positive(process.env.READ_RATE_LIMIT, 180),
});
const server = app.listen(port, host, () =>
  console.log(
    `NAV API: http://${host}:${port}/api/v1 — ${mock ? "in-memory mock" : "FastAPI + Postgres"}; demo identities.`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
