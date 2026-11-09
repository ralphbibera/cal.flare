import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { lookup } from "bcp-47-match";
import { dir } from "i18next";
import localeConfig from "../../../i18n.json";

const locales: string[] = [...localeConfig.locale.targets, localeConfig.locale.source];
const localesDir: string = path.resolve(__dirname, "../../../packages/i18n/locales");
const readCommon = (locale: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(localesDir, locale, "common.json"), "utf8")) as Record<string, string>;
const english: Record<string, string> = readCommon("en");

// getLocale parses Accept-Language and maps it through the same bcp-47 lookup, e.g. es-419 becomes es.
const resolveLocale = (locale: string): string => lookup(locales, locale) ?? locale;

for (const locale of locales) {
  const resolvedLocale = resolveLocale(locale);

  test.describe(`locale ${locale}`, () => {
    test.use({ locale, extraHTTPHeaders: { "accept-language": locale } });

    test("serves bundled translations on a public page", async ({ page }) => {
      const response = await page.goto("/auth/verify-email");
      expect(response?.status()).toBe(200);

      await expect(page.locator("html")).toHaveAttribute("lang", resolvedLocale);
      await expect(page.locator("html")).toHaveAttribute("dir", dir(resolvedLocale) ?? "ltr");
      await expect(page.locator("h2")).toHaveText(
        readCommon(resolvedLocale).check_your_email ?? english.check_your_email
      );

      const body = await page.locator("body").innerText();
      expect(body).not.toContain("check_your_email");
      expect(body).not.toMatch(/\{\{[^}]+\}\}|\[missing|translation missing/i);
    });
  });
}
