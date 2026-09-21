import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("fund decisions link to exact original source bytes", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Fund reconciliations" }),
  ).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page
    .getByRole("link", { name: "Atlas Growth Fund IV", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Calculated NAV is USD 250,000.00 above the reported balance",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View source evidence 3", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Source evidence" });
  await expect(
    dialog.getByRole("heading", { name: "capital_activity.csv" }),
  ).toBeVisible();
  await expect(dialog.getByText("(4000000.00)", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download source" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("capital_activity.csv");
  expect(await readFile((await download.path())!, "utf8")).toContain(
    '"distributions","(4000000.00)"',
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("tab", { name: "Sources" }).click();
  await expect(
    page.getByRole("heading", { name: "Documents behind this decision" }),
  ).toBeVisible();
  expect(failures).toEqual([]);
});

test("rerun polls to completion and leaves the previous run readable", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: "Atlas Growth Fund IV", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Atlas Growth Fund IV", exact: true }),
  ).toBeVisible();
  const previousUrl = page.url();
  await page.getByRole("button", { name: "Rerun", exact: true }).click();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(
    page.getByRole("heading", { name: /Reconciliation (queued|in progress)/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rerun", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", {
      name: "Calculated NAV is USD 250,000.00 above the reported balance",
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Capital roll-forward", exact: true }),
  ).toBeVisible();
  await page.goto(previousUrl);
  await expect(
    page.getByRole("heading", {
      name: "Calculated NAV is USD 250,000.00 above the reported balance",
    }),
  ).toBeVisible();
});

test("needs input and processing failure remain distinct", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: "Oakbridge Private Credit", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "More evidence is needed to reconcile this fund",
    }),
  ).toBeVisible();
  await expect(page.getByText("Not evaluated", { exact: true })).toBeVisible();
  await expect(page.locator(".calc-row.total strong")).toHaveText("—");
  await page.getByRole("link", { name: "All funds", exact: true }).click();
  await page
    .getByRole("link", { name: "Summit Secondaries I", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "This run stopped before a NAV decision",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Capital roll-forward", exact: true }),
  ).not.toBeVisible();
});

test("read-only identity filters funds and cannot open a forbidden run", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: "Atlas Growth Fund IV", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Atlas Growth Fund IV", exact: true }),
  ).toBeVisible();
  const forbiddenUrl = page.url();
  await page
    .getByRole("combobox", { name: "Demo identity" })
    .selectOption("reviewer");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "Atlas Growth Fund IV", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rerun", exact: true }).first(),
  ).toBeDisabled();
  await page.goto(forbiddenUrl);
  await expect(page.getByRole("alert")).toContainText("does not have access");
  await expect(
    page.getByRole("heading", { name: "Atlas Growth Fund IV" }),
  ).not.toBeVisible();
});

test("search, empty period, and mobile layout work with API data", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(6);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("searchbox", { name: "Search funds or administrators" })
    .fill("Meridian");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Reporting period" })
    .selectOption("q1");
  await expect(
    page.getByRole("heading", { name: "No reconciliations for this period" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to Q2 2026" }).click();
  await page
    .getByRole("link", { name: "Meridian Infrastructure II", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Capital roll-forward matched" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("network errors offer retry without inventing an empty portfolio", async ({
  page,
}) => {
  await page.route("**/api/v1/funds?*", (route) => route.abort("failed"));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "Cannot load data from the demo server",
  );
  await expect(
    page.getByRole("heading", { name: "No reconciliations for this period" }),
  ).not.toBeVisible();
  await page.unroute("**/api/v1/funds?*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(6);
});

test("a lost POST response retries the same intent without a duplicate run", async ({
  page,
}) => {
  let acceptedRunId: string | undefined;
  let firstKey: string | undefined;
  await page.route("**/api/v1/funds/*/runs", async (route) => {
    if (!acceptedRunId) {
      firstKey = route.request().headers()["idempotency-key"];
      const accepted = await route.fetch();
      acceptedRunId = (await accepted.json()).run_id;
      await route.abort("failed");
    } else {
      expect(route.request().headers()["idempotency-key"]).toBe(firstKey);
      await route.continue();
    }
  });
  await page.goto("/");
  await page
    .getByRole("link", { name: "Meridian Infrastructure II", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Meridian Infrastructure II",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rerun", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rerun reconciliation" });
  await dialog.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Cannot load data from the demo server",
  );
  await dialog.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${acceptedRunId}$`));
  await expect(
    page.getByRole("heading", { name: "Capital roll-forward matched" }),
  ).toBeVisible();
});

test("first reconciliation publishes a negative variance with signed loss evidence", async ({
  page,
}) => {
  await page.goto("/");
  const row = page
    .getByRole("row")
    .filter({ hasText: "Northline Ventures III" });
  await row
    .getByRole("button", { name: "Start reconciliation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start run", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Calculated NAV is USD 85,000.00 below the reported balance",
    }),
  ).toBeVisible();
  await expect(page.locator(".difference strong")).toHaveText("−85,000.00");
});
