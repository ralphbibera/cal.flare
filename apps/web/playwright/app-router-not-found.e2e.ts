import { expect } from "@playwright/test";
import { expectPageToBeNotFound } from "playwright/lib/testUtils";
import { test } from "./lib/fixtures";

test.describe.configure({ mode: "parallel" });

test.afterEach(({ users }) => users.deleteAll());

test.describe("App Router - error handling", () => {
  test("404s must render App Router's not-found page regardless of whether pages router or app router is used", async ({
    page,
  }) => {
    const response = await page.goto("/123491234");
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("404-page")).toBeVisible();
    await expect(page.getByText("Error 404")).toBeVisible();
    await expect(page.getByRole("heading", { name: "This page does not exist." })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator('meta[name="robots"][content="noindex, nofollow"]')).toHaveCount(1);

    await expectPageToBeNotFound({ page, url: "/login/123491234" });
  });
});
