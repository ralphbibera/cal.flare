import type { TFunction } from "i18next";
import { createInstance } from "i18next";
import { brandTranslations } from "./branding";
import englishTranslations from "./locales/en/common.json";
import type { TranslationDictionary } from "./resources";
import { i18n, loadDictionary } from "./resources";

export function mergeWithEnglishFallback(
  localeTranslations: Readonly<TranslationDictionary>
): TranslationDictionary {
  return brandTranslations({ ...englishTranslations, ...localeTranslations });
}

export async function loadTranslations(_locale: string, _ns: string): Promise<TranslationDictionary> {
  const requestedLocale = _locale === "zh" ? "zh-CN" : _locale;
  const locale = i18n.locales.includes(requestedLocale) ? requestedLocale : "en";
  return mergeWithEnglishFallback(await loadDictionary(locale));
}

export const getTranslation = async (locale: string, ns: string): Promise<TFunction> => {
  const resources = await loadTranslations(locale, ns);
  const instance = createInstance();
  await instance.init({
    lng: locale,
    resources: { [locale]: { [ns]: resources } },
    fallbackLng: "en",
  });
  return instance.getFixedT(locale, ns);
};
