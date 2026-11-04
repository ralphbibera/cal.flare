import type { IAtomsContext } from "@calcom/atoms/hooks/useAtomsContext";
import { AtomsContext } from "@calcom/atoms/hooks/useAtomsContext";
import { loadTranslations } from "@calcom/i18n/server";
import { AppRouterI18nProvider } from "@calcom/web/app/AppRouterI18nProvider";
import { CustomI18nProvider } from "@calcom/web/app/CustomI18nProvider";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createInstance } from "i18next";
import type { JSX, ReactNode } from "react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { useLocale } from "./useLocale";

afterEach(cleanup);

type Dictionary = Awaited<ReturnType<typeof loadTranslations>>;

function wrapper(
  translations: Dictionary,
  locale = "en"
): ({ children }: { children?: ReactNode }) => JSX.Element {
  return ({ children }: { children?: ReactNode }): JSX.Element =>
    createElement(AppRouterI18nProvider, { translations, locale, ns: "common" }, children);
}

function Message(): JSX.Element {
  const { t, i18n, isLocaleReady } = useLocale();
  return createElement("p", { "data-ready": isLocaleReady, dir: i18n.dir() }, t("welcome"));
}

describe("useLocale provider ownership", () => {
  it("keeps same-locale SSR roots with different resources independent", () => {
    const First = wrapper({ welcome: "first request" });
    const Second = wrapper({ welcome: "second request" });
    expect(renderToString(createElement(First, null, createElement(Message)))).toContain("first request");
    expect(renderToString(createElement(Second, null, createElement(Message)))).toContain("second request");
  });

  it("shares one instance within a provider and isolates nested mutations between roots", async () => {
    const dictionary = await loadTranslations("en", "common");
    const first = renderHook(() => [useLocale(), useLocale()], { wrapper: wrapper(dictionary) });
    const second = renderHook(() => useLocale(), { wrapper: wrapper(dictionary) });
    expect(first.result.current[0].i18n).toBe(first.result.current[1].i18n);
    expect(first.result.current[0].i18n).not.toBe(second.result.current.i18n);
    act(() => {
      first.result.current[0].i18n.addResource("en", "common", "welcome", "changed");
      first.result.current[0].i18n.getResourceBundle("en", "common").booking_audit_action.created = "changed";
    });
    expect(second.result.current.t("welcome")).toBe("Welcome");
    expect(second.result.current.t("booking_audit_action.created", { host: "Cal" })).toBe("Booked with Cal");
    expect(dictionary.welcome).toBe("Welcome");
  });

  it("updates resources in the same locale and switches locale without replacing children", async () => {
    const english = await loadTranslations("en", "common");
    const arabic = await loadTranslations("ar", "common");
    const tree = (translations: Dictionary, locale: string): JSX.Element =>
      createElement(AppRouterI18nProvider, { translations, locale, ns: "common" }, createElement(Message));
    const view = render(tree(english, "en"));
    const element = view.container.querySelector("p");
    expect(element?.textContent).toBe("Welcome");
    view.rerender(tree({ ...english, welcome: "Updated English" }, "en"));
    expect(element?.textContent).toBe("Updated English");
    view.rerender(tree(arabic, "ar"));
    expect(view.container.querySelector("p")).toBe(element);
    expect(element?.textContent).toBe("مرحبًا");
    expect(element?.dir).toBe("rtl");
    expect(element?.getAttribute("data-ready")).toBe("true");
  });

  it("retains custom context precedence over App Router and Atoms translations", async () => {
    const english = await loadTranslations("en", "common");
    const atoms: IAtomsContext = {
      clientId: "atoms-client",
      organizationId: 0,
      options: { apiUrl: "" },
      getClient: () => {},
      isAuth: false,
      isValidClient: true,
      isInit: true,
      t: () => "Atoms translation",
      i18n: { language: "en", defaultLocale: "en", locales: ["en"], exists: () => true },
    };
    const Wrapper = ({ children }: { children?: ReactNode }): JSX.Element =>
      createElement(
        AtomsContext.Provider,
        { value: atoms },
        createElement(
          AppRouterI18nProvider,
          { translations: english, locale: "en", ns: "common" },
          createElement(
            CustomI18nProvider,
            { translations: { welcome: "Custom translation" }, locale: "en", ns: "common" },
            children
          )
        )
      );
    const result = renderHook(() => useLocale(), { wrapper: Wrapper });
    expect(result.result.current.t("welcome")).toBe("Custom translation");
    const fallback = renderHook(() => useLocale(), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(AtomsContext.Provider, { value: atoms }, children),
    });
    expect(fallback.result.current.t("welcome")).toBe("Atoms translation");
    expect(fallback.result.current.i18n).toBe(atoms.i18n);
  });

  it("isolates custom provider instances and updates same-locale dictionaries", async () => {
    const english = await loadTranslations("en", "common");
    const tree = (translations: Dictionary): JSX.Element =>
      createElement(
        AppRouterI18nProvider,
        { translations: english, locale: "en", ns: "common" },
        createElement(
          CustomI18nProvider,
          { translations, locale: "en", ns: "common" },
          createElement(Message)
        )
      );
    const first = render(tree({ ...english, welcome: "Custom one" }));
    const second = render(tree({ ...english, welcome: "Custom two" }));
    expect(first.container.textContent).toBe("Custom one");
    expect(second.container.textContent).toBe("Custom two");
    first.rerender(tree({ ...english, welcome: "Custom update" }));
    expect(first.container.textContent).toBe("Custom update");
    expect(second.container.textContent).toBe("Custom two");
  });

  it("retains the react-i18next fallback outside App Router", async () => {
    const instance = createInstance();
    await instance.init({ lng: "en", resources: { en: { common: await loadTranslations("en", "common") } } });
    const result = renderHook(() => useLocale(), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(I18nextProvider, { i18n: instance }, children),
    });
    expect(result.result.current.t("welcome")).toBe("Welcome");
    expect(result.result.current.i18n).toBe(instance);
    expect(result.result.current.isLocaleReady).toBe(true);
  });
});
