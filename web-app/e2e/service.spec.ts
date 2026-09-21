import { expect, test } from "@playwright/test";

test("persistent service supplies decisions, original evidence and new reruns", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Data source" })).toContainText(
    "Fund service · persisted data",
  );
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page
    .getByRole("link", { name: "Atlas Growth Fund IV", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Calculated NAV is USD 250,000.00 above the reported balance",
    }),
  ).toBeVisible();
  const previousUrl = page.url();
  const previousId = previousUrl.split("/").pop();
  const headers = { Authorization: "Bearer demo-operations" };
  const previous = await (
    await request.get(`/api/v1/runs/${previousId}`, { headers })
  ).json();
  await page
    .getByRole("button", { name: "View source evidence 3", exact: true })
    .first()
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Download source" })
    .click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "capital_activity.csv",
  );
  await page.getByRole("button", { name: "Back to reconciliation" }).click();
  await page.getByRole("button", { name: "Rerun", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "read the original source files",
  );
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(
    page.getByRole("heading", {
      name: "Calculated NAV is USD 250,000.00 above the reported balance",
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Capital roll-forward", exact: true }),
  ).toBeVisible();
  const after = await (
    await request.get(`/api/v1/runs/${previousId}`, { headers })
  ).json();
  expect(after).toEqual(previous);
  await page
    .getByRole("combobox", { name: "Demo identity" })
    .selectOption("reviewer");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Rerun", exact: true }).first(),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
