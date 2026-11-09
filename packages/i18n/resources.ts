import localeConfig from "../../i18n.json";
import type { TranslationDictionary } from "./loader";
import { getDictionaryLoader } from "./loader";
import english from "./locales/en/common.json";

export type { TranslationDictionary } from "./loader";

export const i18n: { defaultLocale: string; locales: string[] } = {
  defaultLocale: localeConfig.locale.source,
  locales: [...localeConfig.locale.targets, localeConfig.locale.source],
};

function freezeDictionary(dictionary: TranslationDictionary): Readonly<TranslationDictionary> {
  for (const value of Object.values(dictionary)) {
    if (typeof value !== "string") freezeDictionary(value);
  }
  return Object.freeze(dictionary);
}

const cache: Map<string, Readonly<TranslationDictionary>> = new Map([["en", freezeDictionary(english)]]);

export async function loadDictionary(locale: string): Promise<Readonly<TranslationDictionary>> {
  const cached = cache.get(locale);
  if (cached) return cached;
  if (locale === "en" || !i18n.locales.includes(locale)) return {};
  const loader = getDictionaryLoader();
  if (!loader) throw new Error(`No dictionary loader is bound for locale ${locale}`);
  const immutable = freezeDictionary(await loader(locale));
  cache.set(locale, immutable);
  return immutable;
}
