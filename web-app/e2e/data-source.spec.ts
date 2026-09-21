import { expect, test } from "@playwright/test";

for (const [header, label, detail] of [
  ["mock", "Mock · temporary data", "Resets when Express restarts"],
  ["fund-service", "Fund service · persisted data", "FastAPI + Postgres"],
  ["", "Data source unverified", "API did not identify its data source"],
]) {
  test(`badge follows API header '${header}' regardless of frontend build mode`, async ({
    page,
  }) => {
    await page.route("**/api/v1/funds?*", async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["x-data-source"];
      if (header) headers["x-data-source"] = header;
      await route.fulfill({ response, headers });
    });
    await page.goto("/");
    const badge = page.getByRole("status", { name: "Data source" });
    await expect(badge).toContainText(label);
    await expect(badge).toContainText(detail);
    await expect(
      page.getByText("Fictional sample packs", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(badge).toBeVisible();
    const box = await badge.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
}

test("initial failure has no cached-data claim and retry confirms the source", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/api/v1/funds?*", async (route) => {
    if (fail) await route.abort("connectionfailed");
    else await route.continue();
  });
  await page.goto("/");
  const badge = page.getByRole("status", { name: "Data source" });
  await expect(badge).toContainText("Disconnected · no data loaded");
  await expect(page.locator("tbody tr")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(badge).toContainText(/persisted data|temporary data/);
  await expect(page.locator("tbody tr")).toHaveCount(6);
});

test("failed refresh labels retained results as cached and retry restores connection", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page.route("**/api/v1/funds?*", (route) =>
    route.fulfill({
      status: 503,
      headers: { "X-Data-Source": "fund-service" },
      contentType: "application/json",
      body: "{}",
    }),
  );
  // Allow the existing query's one-second freshness window to expire.
  await page.waitForTimeout(1100);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
  const badge = page.getByRole("status", { name: "Data source" });
  await expect(badge).toContainText("Disconnected · cached data");
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page.unroute("**/api/v1/funds?*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(badge).toContainText(/persisted data|temporary data/);
});
