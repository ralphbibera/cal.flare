"use client";

import type { loadTranslations } from "@calcom/i18n/server";
import type { i18n as I18nInstance, TFunction } from "i18next";
import { createInstance } from "i18next";
import type { Context, JSX, ReactNode } from "react";
import { createContext, useMemo } from "react";

type AppRouterI18nContextType = {
  translations: Awaited<ReturnType<typeof loadTranslations>>;
  ns: string;
  locale: string;
  i18n: I18nInstance;
  t: TFunction;
};

export const AppRouterI18nContext: Context<AppRouterI18nContextType | null> =
  createContext<AppRouterI18nContextType | null>(null);

export function AppRouterI18nProvider({
  children,
  translations,
  locale,
  ns,
}: Omit<AppRouterI18nContextType, "i18n" | "t"> & {
  children?: ReactNode;
}): JSX.Element {
  const value = useMemo(() => {
    const i18n = createInstance();
    void i18n.init({
      lng: locale,
      resources: { [locale]: { [ns]: structuredClone(translations) } },
      initImmediate: false,
    });
    return { translations, locale, ns, i18n, t: i18n.getFixedT(locale, ns) };
  }, [locale, ns, translations]);

  return <AppRouterI18nContext.Provider value={value}>{children}</AppRouterI18nContext.Provider>;
}
