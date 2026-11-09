import type { DictionaryLoader, TranslationDictionary } from "./loader";

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

/** Node tests and tools use the checked-in dictionaries; Worker requests bind asset loading instead. */
export function createBundledDictionaryLoader(): DictionaryLoader {
  return async (locale) => {
    // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn needs ES2022 lib, which API v2 does not target
    const load = Object.prototype.hasOwnProperty.call(dictionaries, locale)
      ? dictionaries[locale]
      : undefined;
    if (!load) return {};
    const { default: dictionary } = await load();
    return dictionary;
  };
}
