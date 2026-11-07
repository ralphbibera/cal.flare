import type { GetServerSidePropsContext } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { loadTranslations } from "@calcom/i18n/server";
import { getCalSessionLocale } from "./cal-session-cookie";
import { getLocale } from "./getLocale";
import { getLocaleFromRequest } from "./getLocaleFromRequest";

vi.mock("./cal-session-cookie", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cal-session-cookie")>()),
  getCalSessionLocale: vi.fn(),
}));
vi.mock("@calcom/features/auth/lib/getServerSession", () => ({ getServerSession: vi.fn() }));

const rootRequest = (acceptLanguage?: string): Parameters<typeof getLocale>[0] =>
  ({
    cookies: {},
    headers: new Headers(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
  }) as unknown as Parameters<typeof getLocale>[0];

const apiRequest = (acceptLanguage?: string): GetServerSidePropsContext["req"] =>
  ({
    headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
  }) as unknown as GetServerSidePropsContext["req"];

describe("root getLocale", () => {
  beforeEach(() => {
    vi.mocked(getCalSessionLocale).mockResolvedValue(null);
  });

  it("prefers the session locale over Accept-Language", async () => {
    vi.mocked(getCalSessionLocale).mockResolvedValue("ja");
    expect(await getLocale(rootRequest("de"))).toBe("ja");
  });

  it.each([
    ["no header", undefined, "en"],
    ["a supported language", "de-DE,en;q=0.5", "de"],
    ["a supported region", "pt-BR,en;q=0.5", "pt-BR"],
    ["a regional variant of a supported language", "es-MX", "es"],
    ["a malformed code", "!!", "en"],
    ["the first preference even when a later one is supported", "xx,de;q=0.9", "xx"],
  ])("resolves %s", async (_case, header, expected) => {
    expect(await getLocale(rootRequest(header))).toBe(expected);
  });

  it("keeps an unsupported language on the document while resources fall back to English", async () => {
    const locale = await getLocale(rootRequest("xx"));
    const translations = await loadTranslations(locale, "common");
    expect(locale).toBe("xx");
    expect(translations.welcome).toBe("Welcome");
  });

  it("does not share a locale between concurrent requests", async () => {
    const headers = ["de", "ja", "ar", "fr", "de", "ar", "ja", "fr"];
    const locales = await Promise.all(headers.map((header) => getLocale(rootRequest(header))));
    expect(locales).toEqual(headers);
  });
});

describe("API getLocaleFromRequest", () => {
  beforeEach(() => {
    vi.mocked(getServerSession).mockResolvedValue(null);
  });

  it("prefers the session locale over Accept-Language", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { locale: "ja" } } as Awaited<
      ReturnType<typeof getServerSession>
    >);
    expect(await getLocaleFromRequest(apiRequest("de"))).toBe("ja");
  });

  it.each([
    ["no header", undefined, "en"],
    ["a later supported preference after an unsupported one", "xx,de;q=0.9", "de"],
    ["a loose language match", "de-CH", "de"],
    ["only unsupported languages", "xx", "en"],
  ])("resolves %s", async (_case, header, expected) => {
    expect(await getLocaleFromRequest(apiRequest(header))).toBe(expected);
  });
});
