import { prisma } from "@calcom/prisma";
import { expect } from "@playwright/test";
import { test } from "../lib/fixtures";
import { submitAndWaitForResponse } from "../lib/testUtils";

test.describe.configure({ mode: "parallel" });

test.afterEach(({ users }) => users.deleteAll());

test.describe("Settings pages", () => {
  test("renders calendars and conferencing settings", async ({ page, users }) => {
    const user = await users.create();
    await user.apiLogin();

    await page.goto("/settings/my-account/calendars");
    await expect(page.getByRole("heading", { name: "Calendars" })).toBeVisible();
    await expect(page.getByTestId("connect-calendar-apps")).toBeVisible();

    await page.goto("/settings/my-account/conferencing");
    await expect(page.getByRole("heading", { name: "Conferencing" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cal Video" }).first()).toBeVisible();
  });

  test("updates the general timezone and persists it", async ({ page, users }) => {
    const user = await users.create({ timeZone: "Europe/London" });
    await user.apiLogin();

    await page.goto("/settings/my-account/general");
    await expect(page.getByRole("heading", { name: "General" })).toBeVisible();

    const timezoneSelect = page.getByTestId("timezone-select").last();
    await timezoneSelect.click();
    await timezoneSelect.locator("input").fill("Europe/Berlin");
    await page.keyboard.press("Enter");

    await submitAndWaitForResponse(page, "/api/trpc/me/updateProfile?batch=1", {
      action: () => page.getByTestId("general-submit-button").click(),
    });

    await expect
      .poll(
        async () =>
          (await prisma.user.findUnique({ where: { id: user.id }, select: { timeZone: true } }))?.timeZone
      )
      .toBe("Europe/Berlin");

    await page.reload();
    await expect(page.getByTestId("timezone-select").last()).toContainText("Europe/Berlin");
  });

  test("renders security and developer settings", async ({ page, users }) => {
    const user = await users.create();
    await user.apiLogin();

    await page.goto("/settings/security/password");
    await expect(page.getByRole("heading", { name: "Password" })).toBeVisible();

    await page.goto("/settings/security/two-factor-auth");
    await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
    await expect(page.getByTestId("two-factor-switch")).toBeVisible();

    await page.goto("/settings/developer/webhooks");
    await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();
    await expect(page.getByTestId("new_webhook")).toBeVisible();
  });
});
