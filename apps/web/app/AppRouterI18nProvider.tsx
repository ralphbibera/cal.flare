"use client";

import type { loadTranslations } from "@calcom/i18n/server";
import type { Context, JSX, ReactNode } from "react";
import { createContext, useMemo } from "react";

type AppRouterI18nContextType = {
  translations: Awaited<ReturnType<typeof loadTranslations>>;
  ns: string;
  locale: string;
};

export const AppRouterI18nContext: Context<AppRouterI18nContextType | null> =
  createContext<AppRouterI18nContextType | null>(null);

export function AppRouterI18nProvider({
  children,
  translations,
  locale,
  ns,
}: AppRouterI18nContextType & {
  children: ReactNode;
}): JSX.Element {
  // Memoize the value to prevent re-renders unless the data changes
  const value = useMemo(
    () => ({
      translations,
      locale,
      ns,
    }),
    [locale, ns]
  );

  return <AppRouterI18nContext.Provider value={value}>{children}</AppRouterI18nContext.Provider>;
}
