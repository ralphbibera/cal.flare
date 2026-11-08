import type { RenderResult } from "@testing-library/react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultInstallation } from "./_utils/installation";
import BookingPageTagManager from "./BookingPageTagManager";
import ga4Handler from "./ga4/api/add";
import ga4Config from "./ga4/config.json";
import { appDataSchema as ga4AppDataSchema } from "./ga4/zod";
import gtmHandler from "./gtm/api/add";
import gtmConfig from "./gtm/config.json";
import { appDataSchema as gtmAppDataSchema } from "./gtm/zod";
import matomoHandler from "./matomo/api/add";
import matomoConfig from "./matomo/config.json";
import { appDataSchema as matomoAppDataSchema } from "./matomo/zod";

vi.mock("./_utils/installation", () => ({
  createDefaultInstallation: vi.fn(),
}));

vi.mock("next/script", () => ({
  default: ({ ...props }: ComponentProps<"script">) => <script {...props} />,
}));

type TagManagerProps = Parameters<typeof BookingPageTagManager>[0];

function renderTagManager(apps: NonNullable<TagManagerProps["eventType"]["metadata"]>["apps"]): RenderResult {
  return render(
    <BookingPageTagManager
      eventType={{
        metadata: { apps },
        price: 0,
        currency: "USD",
      }}
    />
  );
}

const installUser = { id: 7 } as unknown as Parameters<typeof ga4Handler.createCredential>[0]["user"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GA4 analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(ga4Handler).toMatchObject({
      appType: ga4Config.type,
      variant: ga4Config.variant,
      slug: "ga4",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await ga4Handler.createCredential({
      appType: ga4Handler.appType,
      user: installUser,
      slug: ga4Handler.slug,
      teamId: 11,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: ga4Config.type,
      user: installUser,
      slug: "ga4",
      key: {},
      teamId: 11,
    });
  });

  it("validates event type tracking settings", () => {
    expect(ga4AppDataSchema.parse({ enabled: true, trackingId: "G-ABC123" })).toMatchObject({
      enabled: true,
      trackingId: "G-ABC123",
    });
    expect(ga4AppDataSchema.safeParse({ enabled: true, trackingId: 123 }).success).toBe(false);
  });

  it("renders the gtag loader and configuration with the tracking ID", () => {
    renderTagManager({ ga4: { enabled: true, trackingId: "G-ABC123" } });

    const scripts = screen.getAllByTestId("cal-analytics-app-ga4");
    expect(scripts).toHaveLength(2);
    expect(scripts[0].getAttribute("src")).toBe("https://www.googletagmanager.com/gtag/js?id=G-ABC123");
    expect(scripts[1].outerHTML).toContain("gtag('config', 'G-ABC123'");
  });

  it("keeps the tracking ID inside the src attribute", () => {
    const trackingId = `G-1" data-injected="yes`;

    renderTagManager({ ga4: { enabled: true, trackingId } });

    const loader = screen.getAllByTestId("cal-analytics-app-ga4")[0];
    expect(loader.getAttribute("src")).toBe(`https://www.googletagmanager.com/gtag/js?id=${trackingId}`);
    expect(loader.hasAttribute("data-injected")).toBe(false);
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ ga4: { enabled: false, trackingId: "G-ABC123" } });

    expect(screen.queryAllByTestId("cal-analytics-app-ga4")).toHaveLength(0);
  });

  it("renders nothing without event type app configuration", () => {
    renderTagManager({});

    expect(screen.queryAllByTestId("cal-analytics-app-ga4")).toHaveLength(0);
  });
});

describe("GTM analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(gtmHandler).toMatchObject({
      appType: gtmConfig.type,
      variant: gtmConfig.variant,
      slug: "gtm",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await gtmHandler.createCredential({
      appType: gtmHandler.appType,
      user: installUser,
      slug: gtmHandler.slug,
      teamId: 12,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: gtmConfig.type,
      user: installUser,
      slug: "gtm",
      key: {},
      teamId: 12,
    });
  });

  it("normalizes tracking IDs to the GTM- prefix", () => {
    expect(gtmAppDataSchema.parse({ enabled: true, trackingId: "123" }).trackingId).toBe("GTM-123");
    expect(gtmAppDataSchema.parse({ enabled: true, trackingId: " GTM-123 " }).trackingId).toBe("GTM-123");
    expect(gtmAppDataSchema.parse({ enabled: true, trackingId: "" }).trackingId).toBe("GTM-");
  });

  it("requires a string tracking ID", () => {
    expect(gtmAppDataSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(gtmAppDataSchema.safeParse({ enabled: true, trackingId: 123 }).success).toBe(false);
  });

  it("renders the normalized tracking ID from validated event type data", () => {
    const validatedData = gtmAppDataSchema.parse({ enabled: true, trackingId: "321" });

    renderTagManager({ gtm: validatedData });

    const scripts = screen.getAllByTestId("cal-analytics-app-gtm");
    expect(scripts).toHaveLength(2);
    expect(scripts[0].outerHTML).toContain("'GTM-321'");
    expect(scripts[1].outerHTML).toContain("cal_analytics_app__gtm");
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ gtm: { enabled: false, trackingId: "GTM-123" } });

    expect(screen.queryAllByTestId("cal-analytics-app-gtm")).toHaveLength(0);
  });
});

describe("Matomo analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(matomoHandler).toMatchObject({
      appType: matomoConfig.type,
      variant: matomoConfig.variant,
      slug: "matomo",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await matomoHandler.createCredential({
      appType: matomoHandler.appType,
      user: installUser,
      slug: matomoHandler.slug,
      teamId: 13,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: matomoConfig.type,
      user: installUser,
      slug: "matomo",
      key: {},
      teamId: 13,
    });
  });

  it("validates event type tracking settings", () => {
    expect(
      matomoAppDataSchema.parse({
        enabled: true,
        MATOMO_URL: "https://matomo.example.com",
        SITE_ID: "7",
      })
    ).toMatchObject({
      enabled: true,
      MATOMO_URL: "https://matomo.example.com",
      SITE_ID: "7",
    });
    expect(matomoAppDataSchema.safeParse({ enabled: true, SITE_ID: 7 }).success).toBe(false);
  });

  it("renders the Matomo loader and configuration with the URL and site ID", () => {
    renderTagManager({
      matomo: { enabled: true, MATOMO_URL: "https://matomo.example.com", SITE_ID: "7" },
    });

    const scripts = screen.getAllByTestId("cal-analytics-app-matomo");
    expect(scripts).toHaveLength(2);
    expect(scripts[0].getAttribute("src")).toBe("https://matomo.example.com/matomo.js");
    expect(scripts[1].outerHTML).toContain("var u='https://matomo.example.com/';");
    expect(scripts[1].outerHTML).toContain("_paq.push(['setSiteId', '7']);");
  });

  it("keeps the Matomo URL inside the src attribute", () => {
    const matomoUrl = `https://matomo.example.com" onload="alert(1)`;

    renderTagManager({ matomo: { enabled: true, MATOMO_URL: matomoUrl, SITE_ID: "7" } });

    const loader = screen.getAllByTestId("cal-analytics-app-matomo")[0];
    expect(loader.getAttribute("src")).toBe(`${matomoUrl}/matomo.js`);
    expect(loader.hasAttribute("onload")).toBe(false);
  });

  it("renders nothing when disabled", () => {
    renderTagManager({
      matomo: { enabled: false, MATOMO_URL: "https://matomo.example.com", SITE_ID: "7" },
    });

    expect(screen.queryAllByTestId("cal-analytics-app-matomo")).toHaveLength(0);
  });
});
