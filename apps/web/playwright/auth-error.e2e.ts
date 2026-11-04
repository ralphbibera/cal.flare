import { expect, test } from "@playwright/test";

for (const { locale, lang, dir, title } of [
  { locale: "en-US", lang: "en", dir: "ltr", title: "Error | Cal.diy" },
  { locale: "de-DE", lang: "de", dir: "ltr", title: "Fehler | Cal.diy" },
  { locale: "ar-SA", lang: "ar", dir: "rtl", title: "خطأ | Cal.diy" },
]) {
  test.describe(locale, () => {
    test.use({ locale });
    test("renders the original error page with locale and metadata", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await page.goto("/auth/error?error=Verification");
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(title);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      await expect(page.getByRole("link")).toHaveAttribute("href", "/auth/login");
      await expect(page.locator("body")).toContainText("Verification");
      expect(errors).toEqual([]);
    });
  });
}
