import { useAtomsContext } from "@calcom/atoms/hooks/useAtomsContext";
import { AppRouterI18nContext } from "@calcom/web/app/AppRouterI18nProvider";
import { CustomI18nContext } from "@calcom/web/app/CustomI18nProvider";
import type { i18n, TFunction } from "i18next";
import { useContext } from "react";
import { useTranslation } from "react-i18next";

type useLocaleReturnType = {
  i18n: i18n;
  t: TFunction;
  isLocaleReady: boolean;
};

// @internal
const useClientLocale = (instance?: i18n): useLocaleReturnType => {
  const context = useAtomsContext();
  const { i18n, t } = useTranslation("common", { i18n: instance });
  const isLocaleReady = Object.keys(i18n).length > 0;
  if (context?.clientId) {
    return { i18n: context.i18n, t: context.t, isLocaleReady: true } as unknown as useLocaleReturnType;
  }
  return {
    i18n,
    t,
    isLocaleReady,
  };
};

export const useLocale = (): useLocaleReturnType => {
  const appRouterContext = useContext(AppRouterI18nContext);
  const customI18nContext = useContext(CustomI18nContext);
  const context = appRouterContext ? (customI18nContext ?? appRouterContext) : null;
  const clientI18n = useClientLocale(context?.i18n);

  if (context) {
    return { i18n: context.i18n, t: context.t, isLocaleReady: true };
  }

  console.warn(
    "useLocale hook is being used outside of App Router - hence this hook will use a global, client-side i18n which can cause a small flicker"
  );
  return {
    t: clientI18n.t,
    isLocaleReady: clientI18n.isLocaleReady,
    i18n: clientI18n.i18n,
  };
};
