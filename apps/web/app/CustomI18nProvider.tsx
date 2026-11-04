"use client";

import type { loadTranslations } from "@calcom/i18n/server";
import type { Context, JSX, ReactNode } from "react";
import { createContext, useMemo } from "react";

type CustomI18nContextType = {
  translations: Awaited<ReturnType<typeof loadTranslations>>;
  ns: string;
  locale: string;
};

export const CustomI18nContext: Context<CustomI18nContextType | null> =
  createContext<CustomI18nContextType | null>(null);

export function CustomI18nProvider({
  children,
  translations,
  locale,
  ns,
}: CustomI18nContextType & {
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

  return <CustomI18nContext.Provider value={value}>{children}</CustomI18nContext.Provider>;
}
