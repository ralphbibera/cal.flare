import { expect, test } from "@playwright/test";

for (const { locale, lang, dir, title } of [
  { locale: "en-US", lang: "en", dir: "ltr", title: "Error | Cal.flare" },
  { locale: "de-DE", lang: "de", dir: "ltr", title: "Fehler | Cal.flare" },
  { locale: "ar-SA", lang: "ar", dir: "rtl", title: "خطأ | Cal.flare" },
  { locale: "ja-JP", lang: "ja", dir: "ltr", title: "エラー | Cal.flare" },
  { locale: "zh", lang: "zh", dir: "ltr", title: "错误 | Cal.flare" },
  { locale: "zz-ZZ", lang: "zz-ZZ", dir: "ltr", title: "Error | Cal.flare" },
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

test("serves an unauthenticated session through the native Better Auth API", async ({ request }) => {
  const response = await request.get("/api/auth/get-session");
  expect(response.status()).toBe(200);
  expect(await response.json()).toBeNull();
});

test("serves bundled viewer translations through the original tRPC API", async ({ request }) => {
  for (const { locale, resolved, common } of [
    { locale: "de-DE", resolved: "de", common: { welcome: "Willkommen" } },
    { locale: "zh", resolved: "zh", common: {} },
    { locale: "zz-ZZ", resolved: "zz-ZZ", common: {} },
  ]) {
    const response = await request.get("/api/trpc/i18n/get", {
      params: { input: JSON.stringify({ json: { locale, CalComVersion: "api-regression" } }) },
      headers: { "accept-language": "ar-SA" },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        data: {
          json: {
            locale: resolved,
            i18n: {
              _nextI18Next: {
                initialLocale: resolved,
                ns: ["common", "vital"],
                initialI18nStore: {
                  [resolved]: { common, vital: {} },
                  en: { common: { welcome: "Welcome" }, vital: {} },
                },
              },
            },
          },
        },
      },
    });
  }
});
