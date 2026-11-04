import german from "@calcom/i18n/locales/de/common.json";
import english from "@calcom/i18n/locales/en/common.json";
import chinese from "@calcom/i18n/locales/zh-CN/common.json";
import { createInstance } from "i18next";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-i18next/serverSideTranslations", () => {
  throw new Error("Filesystem translation loading reached");
});
vi.mock("i18next-fs-backend", () => {
  throw new Error("Filesystem translation backend reached");
});

import { i18nHandler } from "./i18n.handler";

describe("i18n handler", () => {
  it.each([
    "en",
    "de",
    "zh",
    "xx-INVALID",
  ])("preserves %s SSR resources and empty missing namespaces", async (locale) => {
    const result = await i18nHandler({ input: { locale, CalComVersion: "1.0" } });
    const state = result.i18n._nextI18Next;
    expect(result.locale).toBe(locale);
    expect(state.initialLocale).toBe(locale);
    expect(state.ns).toEqual(["common", "vital"]);
    expect(state.initialI18nStore.en).toEqual({ common: english, vital: {} });
    if (locale === "de") expect(state.initialI18nStore.de).toEqual({ common: german, vital: {} });
    if (locale === "zh") {
      expect(state.initialI18nStore.zh).toEqual({ common: {}, vital: {} });
      expect(state.initialI18nStore["zh-CN"]).toEqual({ common: chinese, vital: {} });
    }
    if (locale === "xx-INVALID") expect(state.initialI18nStore[locale]).toEqual({ common: {}, vital: {} });
    expect(state.userConfig.i18n.defaultLocale).toBe("en");
    expect(state.userConfig.fallbackLng).toEqual({ default: ["en"], zh: ["zh-CN"] });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("keeps the viewer interpolation and missing-key policy", async () => {
    const { i18n: payload } = await i18nHandler({ input: { locale: "de", CalComVersion: "1.0" } });
    const state = payload._nextI18Next;
    const instance = createInstance();
    await instance.init({
      ...state.userConfig,
      lng: state.initialLocale,
      resources: state.initialI18nStore,
      ns: state.ns,
      defaultNS: "common",
      load: "currentOnly",
      interpolation: { escapeValue: false },
    });
    expect(instance.t("welcome")).toBe("Willkommen");
    expect(instance.t("continue_with", { appName: "<Cal>" })).toBe("Mit <Cal> fortfahren");
    expect(instance.t("missing_translation_key")).toBe("missing_translation_key");
    expect(instance.t("welcome", { ns: "vital" })).toBe("welcome");
  });

  it("isolates concurrent SSR resource mutations", async () => {
    const input = { locale: "de", CalComVersion: "1.0" };
    const [first, second] = await Promise.all([i18nHandler({ input }), i18nHandler({ input })]);
    first.i18n._nextI18Next.initialI18nStore.de.common.welcome = "changed";
    first.i18n._nextI18Next.userConfig.i18n.locales.push("changed");
    first.i18n._nextI18Next.ns.push("changed");
    expect(second.i18n._nextI18Next.initialI18nStore.de.common.welcome).toBe("Willkommen");
    const next = await i18nHandler({ input });
    expect(next).toEqual(second);
  });
});
