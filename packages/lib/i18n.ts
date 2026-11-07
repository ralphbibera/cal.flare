import i18nConfig from "@calcom/i18n/next-i18next.config";

// The config is CommonJS, so platform-libraries' Rollup build only sees a default export.
const { i18n } = i18nConfig;

// Workaround for using router.locales from old router
export const locales = i18n.locales;

export const localeOptions = locales.map((locale) => ({
  value: locale,
  label: new Intl.DisplayNames(locale, { type: "language" }).of(locale) || "",
}));

export const defaultLocaleOption = localeOptions.find(
  (locale) => locale.value === i18n.defaultLocale
) as (typeof localeOptions)[number];
