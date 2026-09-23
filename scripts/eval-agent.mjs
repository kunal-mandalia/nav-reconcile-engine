import { spawnSync } from "node:child_process";
const result = spawnSync(
  "uv",
  [
    "run",
    "--project",
    "fund-service",
    "python",
    "scripts/eval-agent.py",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: process.env,
  },
);
process.exit(result.status ?? 1);
