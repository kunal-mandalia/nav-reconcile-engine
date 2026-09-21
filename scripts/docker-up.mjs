import { spawnSync } from "node:child_process";

const mode = process.env.CLIENT_API_BACKEND ?? "fund-service";
if (!["mock", "fund-service"].includes(mode)) {
  console.error("CLIENT_API_BACKEND must be mock or fund-service.");
  process.exit(1);
}
function compose(...args) {
  const result = spawnSync("docker", ["compose", ...args], {
    stdio: "inherit",
    env: { ...process.env, CLIENT_API_BACKEND: mode },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Starting Docker demo with CLIENT_API_BACKEND=${mode}`);
if (mode === "fund-service")
  compose("up", "--build", "-d", "--wait", "fund-service");
compose("up", "--build", "-d", "--wait", "web-app");
if (mode === "mock") compose("stop", "fund-service", "postgres");
console.log(
  `Demo ready at http://127.0.0.1:5173 (${mode}). Refresh any open browser tab after switching modes.`,
);
