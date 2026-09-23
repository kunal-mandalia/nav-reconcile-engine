import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

if (!process.env.DATABASE_URL)
  throw new Error("Root .env must contain DATABASE_URL");
const dbName = `nav_agent_e2e_${randomUUID().replaceAll("-", "")}`;
const database = new URL(process.env.DATABASE_URL);
database.pathname = `/${dbName}`;
const temp = mkdtempSync(join(tmpdir(), "nav-agent-e2e-"));
const env = {
  ...process.env,
  OPENAI_API_KEY: "",
  TEST_DATABASE_NAME: dbName,
  TEST_DATABASE_URL: database.href,
  SOURCE_DIR: join(temp, "sources"),
  FUND_SERVICE_TOKEN: "offline-agent-e2e-service-credential-only",
  FUND_SERVICE_URL: "http://127.0.0.1:8105",
  CLIENT_API_BACKEND: "fund-service",
  PORT: "4105",
  READ_RATE_LIMIT: "1000",
  RUN_RATE_LIMIT: "100",
  PYTHONPATH: `${resolve("fund-service")}:${resolve("fund-service/tests")}`,
};
function db(operation) {
  const result = spawnSync(
    "uv",
    [
      "run",
      "--project",
      "fund-service",
      "python",
      "-c",
      `
import os, psycopg
from psycopg import sql
with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as conn:
    conn.execute(sql.SQL('${operation === "create" ? "CREATE DATABASE {}" : "DROP DATABASE {} WITH (FORCE)"}').format(sql.Identifier(os.environ['TEST_DATABASE_NAME'])))
`,
    ],
    { env, stdio: "pipe" },
  );
  if (result.status !== 0)
    throw new Error(`Could not ${operation} isolated test database`);
}
const children = [];
function launch(cmd, args) {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  // Keep potentially verbose service output out of reports. Process errors fail readiness.
  child.stdout.resume();
  child.stderr.resume();
  children.push(child);
  return child;
}
async function ready(url) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (children.some((c) => c.exitCode !== null))
      throw new Error("An E2E service exited during startup");
    try {
      if (
        (
          await fetch(url, {
            headers: { Authorization: "Bearer demo-operations" },
          })
        ).ok
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Service not ready: ${url}`);
}
let browser,
  vite,
  created = false;
try {
  db("create");
  created = true;
  launch("uv", [
    "run",
    "--project",
    "fund-service",
    "python",
    "-m",
    "uvicorn",
    "e2e_agent_app:app",
    "--factory",
    "--host",
    "127.0.0.1",
    "--port",
    "8105",
  ]);
  await ready("http://127.0.0.1:8105/healthz");
  launch(process.execPath, [
    "--import",
    "tsx",
    "web-server/src/index.ts",
    "--service",
  ]);
  await ready("http://127.0.0.1:4105/api/v1/funds");
  vite = await createServer({
    root: "web-app",
    configFile: "web-app/vite.config.ts",
    server: {
      host: "127.0.0.1",
      port: 3105,
      strictPort: true,
      proxy: { "/api": "http://127.0.0.1:4105" },
    },
  });
  await vite.listen();
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3105");
  await expect(
    page.getByRole("status", { name: "Processing mode" }),
  ).toContainText("Agent-assisted");
  const fund = page
    .locator("tbody tr")
    .filter({ hasText: "Harbor Infrastructure III" });
  await expect(fund).toBeVisible();
  await fund
    .getByRole("button", { name: "Start reconciliation", exact: true })
    .click();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Calculated NAV is USD 75,000.00 above the reported balance",
    }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("Visual + source checks passed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Agent plan · validated wording", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View source evidence 1", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("File record 13");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Download source" })
    .click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "capital_account_messy.csv",
  );
  await page.getByRole("button", { name: "Back to reconciliation" }).click();
  const previous = page.url();
  await page.reload();
  await expect(
    page.getByText("Visual + source checks passed", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rerun", exact: true }).click();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page).not.toHaveURL(previous);
  await expect(
    page.getByText("Visual + source checks passed", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "PASS: real worker → Postgres → Express → browser; agent labels, exact result, evidence, download, reload, rerun, mobile layout. No live model calls.",
  );
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
  }
  if (created) db("drop");
  rmSync(temp, { recursive: true, force: true });
}
