import { spawnSync } from "node:child_process";

const result = spawnSync("uv", ["run", "--project", "fund-service", "pytest", "fund-service/tests", "-q"], {
  stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL },
});
process.exit(result.status ?? 1);
