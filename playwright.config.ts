import { defineConfig, devices } from "@playwright/test";

const serviceMode = process.env.NAV_E2E_MODE === "service";
export default defineConfig({
  testDir: "./web-app/e2e",
  testMatch: [
    serviceMode ? "service.spec.ts" : "flows.spec.ts",
    "data-source.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: { baseURL: "http://127.0.0.1:3700", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
      },
    },
  ],
  webServer: {
    command: serviceMode ? "npm run dev:service" : "npm run dev",
    url: "http://127.0.0.1:3700",
    reuseExistingServer: !process.env.CI,
    timeout: serviceMode ? 180000 : 30000,
  },
});
