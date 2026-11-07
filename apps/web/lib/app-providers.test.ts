// @vitest-environment jsdom

import { getServerTranslations } from "@calcom/i18n/ssr";
import type { i18n } from "i18next";
import type { JSX } from "react";
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useTranslation } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

vi.mock("@calcom/features/flags/context/provider", () => ({ FeatureProvider: vi.fn() }));
vi.mock("@calcom/web/modules/feature-flags/hooks/useFlags", () => ({ useFlags: vi.fn() }));
vi.mock("@components/I18nLanguageHandler", () => ({ useViewerI18n: vi.fn() }));
vi.mock("@lib/hooks/useIsBookingPage", () => ({ default: vi.fn() }));
vi.mock("@lib/hooks/useNuqsParams", () => ({ useNuqsParams: vi.fn() }));
vi.mock("@calcom/features/auth/client", () => ({ useSession: vi.fn() }));
vi.mock("next-themes", () => ({ ThemeProvider: vi.fn() }));
vi.mock("nuqs/adapters/next/pages", () => ({ NuqsAdapter: vi.fn() }));
vi.mock("next-i18next", () => {
  throw new Error("Legacy Pages translation runtime reached");
});

import { I18nextAdapter } from "./app-providers";

function Message({ capture }: { capture?: (instance: i18n) => void }): JSX.Element {
  const { t, i18n, ready } = useTranslation("common");
  capture?.(i18n);
  return createElement(
    "p",
    { dir: i18n.dir(), "data-ready": ready },
    `${t("welcome")}|${t("continue_with", { appName: "<Cal>" })}`
  );
}

function tree(
  payload: Awaited<ReturnType<typeof getServerTranslations>>,
  capture?: (instance: i18n) => void
): JSX.Element {
  return createElement(I18nextAdapter, { pageProps: payload }, createElement(Message, { capture }));
}

describe("Pages translation adapter", () => {
  it("hydrates serialized server resources and changes locale without a remount", async () => {
    const german = await getServerTranslations("de", ["common", "vital"]);
    const arabic = await getServerTranslations("ar", ["common", "vital"]);
    const content = tree(JSON.parse(JSON.stringify(german)));
    const container = document.createElement("div");
    container.innerHTML = renderToString(content);
    document.body.append(container);
    expect(container.textContent).toBe("Willkommen|Mit <Cal> fortfahren");
    const element = container.querySelector("p");
    const errors: unknown[] = [];
    const root = hydrateRoot(container, content, {
      onRecoverableError: (error: unknown) => errors.push(error),
    });
    try {
      await act(async () => {});
      expect(container.querySelector("p")?.getAttribute("data-ready")).toBe("true");
      await act(async () => root.render(tree(arabic)));
      expect(container.querySelector("p")).toBe(element);
      expect(container.querySelector("p")?.dir).toBe("rtl");
      expect(container.textContent).toContain("مرحبًا");
      await act(async () => root.render(tree(german)));
      expect(container.querySelector("p")?.dir).toBe("ltr");
      expect(container.textContent).toBe("Willkommen|Mit <Cal> fortfahren");
      expect(errors).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("isolates same-locale SSR roots, nested resources and serialized props", async () => {
    const payload = await getServerTranslations("en", ["common", "vital"]);
    const instances: i18n[] = [];
    renderToString(tree(payload, (instance) => instances.push(instance)));
    renderToString(tree(payload, (instance) => instances.push(instance)));
    const [first, second] = instances;
    expect(first).not.toBe(second);
    first.addResource("en", "common", "welcome", "changed");
    first.getResourceBundle("en", "common").booking_audit_action.created = "changed";
    expect(second.t("welcome")).toBe("Welcome");
    expect(second.t("booking_audit_action.created", { host: "Cal" })).toBe("Booked with Cal");
    expect(payload._nextI18Next.initialI18nStore.en.common.welcome).toBe("Welcome");
    expect(renderToString(tree(payload))).toContain("Welcome");
  });

  it("retains Chinese, unsupported-locale and missing-namespace behavior", async () => {
    const chinese = await getServerTranslations("zh", ["common", "vital"]);
    const unknown = await getServerTranslations("xx-INVALID", ["common", "vital"]);
    expect(renderToString(tree(chinese))).toContain("欢迎");
    expect(renderToString(tree(unknown))).toContain("Welcome");
    const instances: i18n[] = [];
    renderToString(tree(chinese, (instance) => instances.push(instance)));
    expect(instances[0].t("welcome", { ns: "vital" })).toBe("welcome");
    expect(instances[0].t("missing_key")).toBe("missing_key");
  });
});
