import { expect } from "@playwright/test";
import { test } from "../lib/fixtures";

test.describe.configure({ mode: "parallel" });

test.afterEach(({ users }) => users.deleteAll());

test.describe("App store", () => {
  test("renders the app store and an app card", async ({ page, users }) => {
    const user = await users.create();
    await user.apiLogin();

    await page.goto("/apps");
    await expect(page.getByRole("heading", { name: /app store/i }).first()).toBeVisible();

    await page.goto("/apps/categories/analytics");
    await expect(page.getByTestId("app-store-app-card-gtm")).toBeVisible();
  });

  test("navigates the installed app categories", async ({ page, users }) => {
    const user = await users.create();
    await user.apiLogin();

    await page.goto("/apps/installed/calendar");
    await expect(page.getByTestId("connect-calendar-apps")).toBeVisible();

    await page.goto("/apps/installed/conferencing");
    await expect(page.getByRole("heading", { name: "Cal Video" }).first()).toBeVisible();

    await page.goto("/apps/installed/payment");
    await expect(page.getByTestId("connect-payment-apps")).toBeVisible();

    await page.goto("/apps/installed/automation");
    await expect(page.getByTestId("connect-automation-apps")).toBeVisible();
  });
});
