import type { InitOptions } from "i18next";
import type { TranslationDictionary } from "./resources";
import { i18n, loadDictionary } from "./resources";

export type SSRConfig = {
  _nextI18Next: {
    initialI18nStore: Record<string, Record<string, TranslationDictionary>>;
    initialLocale: string;
    ns: string[];
    userConfig: InitOptions & { i18n: typeof i18n };
  };
};

export async function getServerTranslations(locale: string, namespaces: string[]): Promise<SSRConfig> {
  const locales = Array.from(new Set([locale, ...(locale === "zh" ? ["zh-CN"] : []), "en"]));
  const entries = await Promise.all(
    locales.map(async (language): Promise<[string, Record<string, TranslationDictionary>]> => {
      const dictionary = await loadDictionary(language);
      return [
        language,
        Object.fromEntries(namespaces.map((ns) => [ns, ns === "common" ? structuredClone(dictionary) : {}])),
      ];
    })
  );
  const initialI18nStore = Object.fromEntries(entries);
  return {
    _nextI18Next: {
      initialI18nStore,
      initialLocale: locale,
      ns: [...namespaces],
      userConfig: {
        i18n: { defaultLocale: i18n.defaultLocale, locales: [...i18n.locales] },
        fallbackLng: { default: ["en"], zh: ["zh-CN"] },
      },
    },
  };
}
