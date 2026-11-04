"use client";

import type { loadTranslations } from "@calcom/i18n/server";
import type { i18n as I18nInstance, TFunction } from "i18next";
import { createInstance } from "i18next";
import type { Context, JSX, ReactNode } from "react";
import { createContext, useMemo } from "react";

type CustomI18nContextType = {
  translations: Awaited<ReturnType<typeof loadTranslations>>;
  ns: string;
  locale: string;
  i18n: I18nInstance;
  t: TFunction;
};

export const CustomI18nContext: Context<CustomI18nContextType | null> =
  createContext<CustomI18nContextType | null>(null);

export function CustomI18nProvider({
  children,
  translations,
  locale,
  ns,
}: Omit<CustomI18nContextType, "i18n" | "t"> & {
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

  return <CustomI18nContext.Provider value={value}>{children}</CustomI18nContext.Provider>;
}
