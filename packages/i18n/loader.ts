import { AsyncLocalStorage } from "node:async_hooks";

export type TranslationDictionary = { [key: string]: string | TranslationDictionary };

export type DictionaryLoader = (locale: string) => Promise<TranslationDictionary>;

export interface DictionaryAssets {
  fetch(request: Request): Promise<Response>;
}

const storageKey = Symbol.for("calflare.i18n.dictionary-storage");
const shared = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<DictionaryLoader>;
};
// Vinext evaluates server modules separately for RSC and Pages/SSR.
const scope = (shared[storageKey] ??= new AsyncLocalStorage<DictionaryLoader>());

let fallbackLoader: DictionaryLoader | undefined;

export function withDictionaryLoader<T>(loader: DictionaryLoader, callback: () => T): T {
  return scope.run(loader, callback);
}

export function setFallbackDictionaryLoader(loader: DictionaryLoader | undefined): void {
  fallbackLoader = loader;
}

export function getDictionaryLoader(): DictionaryLoader | undefined {
  return scope.getStore() ?? fallbackLoader;
}

export function createAssetDictionaryLoader(
  assets: DictionaryAssets | undefined,
  baseUrl: string
): DictionaryLoader {
  return async (locale) => {
    if (!assets) throw new Error("The ASSETS binding is required to load dictionaries");
    const assetPath = `/_next/static/locales/${locale}/common.json`;
    const response = await assets.fetch(new Request(new URL(assetPath, baseUrl)));
    if (!response.ok) {
      throw new Error(`Unable to load dictionary asset ${assetPath} (${response.status})`);
    }
    const dictionary: unknown = await response.json();
    if (typeof dictionary !== "object" || dictionary === null || Array.isArray(dictionary)) {
      throw new Error(`Dictionary asset ${assetPath} is not an object`);
    }
    return dictionary as TranslationDictionary;
  };
}
