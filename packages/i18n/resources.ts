import localeConfig from "../../i18n.json";
import english from "./locales/en/common.json";

export type TranslationDictionary = { [key: string]: string | TranslationDictionary };

export const i18n: { defaultLocale: string; locales: string[] } = {
  defaultLocale: localeConfig.locale.source,
  locales: [...localeConfig.locale.targets, localeConfig.locale.source],
};

const dictionaries: Record<string, () => Promise<{ default: TranslationDictionary }>> = {
  ar: () => import("./locales/ar/common.json"),
  az: () => import("./locales/az/common.json"),
  bg: () => import("./locales/bg/common.json"),
  bn: () => import("./locales/bn/common.json"),
  ca: () => import("./locales/ca/common.json"),
  cs: () => import("./locales/cs/common.json"),
  da: () => import("./locales/da/common.json"),
  de: () => import("./locales/de/common.json"),
  el: () => import("./locales/el/common.json"),
  es: () => import("./locales/es/common.json"),
  "es-419": () => import("./locales/es-419/common.json"),
  eu: () => import("./locales/eu/common.json"),
  et: () => import("./locales/et/common.json"),
  fi: () => import("./locales/fi/common.json"),
  fr: () => import("./locales/fr/common.json"),
  he: () => import("./locales/he/common.json"),
  hu: () => import("./locales/hu/common.json"),
  id: () => import("./locales/id/common.json"),
  it: () => import("./locales/it/common.json"),
  ja: () => import("./locales/ja/common.json"),
  km: () => import("./locales/km/common.json"),
  ko: () => import("./locales/ko/common.json"),
  nl: () => import("./locales/nl/common.json"),
  no: () => import("./locales/no/common.json"),
  pl: () => import("./locales/pl/common.json"),
  "pt-BR": () => import("./locales/pt-BR/common.json"),
  pt: () => import("./locales/pt/common.json"),
  ro: () => import("./locales/ro/common.json"),
  ru: () => import("./locales/ru/common.json"),
  "sk-SK": () => import("./locales/sk-SK/common.json"),
  sr: () => import("./locales/sr/common.json"),
  sv: () => import("./locales/sv/common.json"),
  tr: () => import("./locales/tr/common.json"),
  uk: () => import("./locales/uk/common.json"),
  vi: () => import("./locales/vi/common.json"),
  "zh-CN": () => import("./locales/zh-CN/common.json"),
  "zh-TW": () => import("./locales/zh-TW/common.json"),
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
  const load = Object.hasOwn(dictionaries, locale) ? dictionaries[locale] : undefined;
  if (!load) return {};
  const { default: dictionary } = await load();
  const immutable = freezeDictionary(dictionary);
  cache.set(locale, immutable);
  return immutable;
}
