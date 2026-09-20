import { createApp } from "./app.js";
import { MockFundService } from "./service.js";

if (!process.argv.includes("--mock") || process.env.NODE_ENV === "production") {
  throw new Error(
    "This server currently supports explicit local --mock mode only. It must not be deployed as production authentication.",
  );
}
function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(
      "Port, timing and limit settings must be positive integers.",
    );
  return parsed;
}
const port = positive(process.env.PORT, 4000);
const app = createApp({
  service: new MockFundService({
    stageMs: positive(process.env.MOCK_STAGE_MS, 1000),
  }),
  runLimit: positive(process.env.RUN_RATE_LIMIT, 6),
  readLimit: positive(process.env.READ_RATE_LIMIT, 180),
});
const server = app.listen(port, "127.0.0.1", () =>
  console.log(
    `Mock NAV API: http://127.0.0.1:${port}/api/v1 — fictional data, resets on restart.`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
