import type { RenderResult } from "@testing-library/react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultInstallation } from "./_utils/installation";
import BookingPageTagManager from "./BookingPageTagManager";
import plausibleHandler from "./plausible/api/add";
import plausibleConfig from "./plausible/config.json";
import { appDataSchema as plausibleAppDataSchema } from "./plausible/zod";
import posthogHandler from "./posthog/api/add";
import posthogConfig from "./posthog/config.json";
import { appDataSchema as posthogAppDataSchema } from "./posthog/zod";
import umamiHandler from "./umami/api/add";
import umamiConfig from "./umami/config.json";
import { appDataSchema as umamiAppDataSchema } from "./umami/zod";

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

const installUser = { id: 7 } as unknown as Parameters<typeof plausibleHandler.createCredential>[0]["user"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Plausible analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(plausibleHandler).toMatchObject({
      appType: plausibleConfig.type,
      variant: plausibleConfig.variant,
      slug: "plausible",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await plausibleHandler.createCredential({
      appType: plausibleHandler.appType,
      user: installUser,
      slug: plausibleHandler.slug,
      teamId: 21,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: plausibleConfig.type,
      user: installUser,
      slug: "plausible",
      key: {},
      teamId: 21,
    });
  });

  it("validates event type tracking settings and defaults the script URL", () => {
    expect(plausibleAppDataSchema.parse({ enabled: true, trackingId: "example.com" })).toMatchObject({
      enabled: true,
      trackingId: "example.com",
      PLAUSIBLE_URL: "https://plausible.io/js/script.js",
    });
    expect(
      plausibleAppDataSchema.parse({
        enabled: true,
        PLAUSIBLE_URL: "https://analytics.example.com/js/script.js",
        trackingId: "example.com",
      })
    ).toMatchObject({
      PLAUSIBLE_URL: "https://analytics.example.com/js/script.js",
    });
    expect(plausibleAppDataSchema.safeParse({ enabled: true, trackingId: 123 }).success).toBe(false);
  });

  it("renders the Plausible script URL and tracked domain", () => {
    renderTagManager({
      plausible: {
        enabled: true,
        PLAUSIBLE_URL: "https://analytics.example.com/js/script.js",
        trackingId: "example.com",
      },
    });

    const scripts = screen.getAllByTestId("cal-analytics-app-plausible");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe("https://analytics.example.com/js/script.js");
    expect(scripts[0].getAttribute("data-domain")).toBe("example.com");
  });

  it("keeps the tracked domain inside the data-domain attribute", () => {
    const trackingId = `example.com" data-injected="yes`;

    renderTagManager({ plausible: { enabled: true, trackingId } });

    const script = screen.getByTestId("cal-analytics-app-plausible");
    expect(script.getAttribute("data-domain")).toBe(trackingId);
    expect(script.hasAttribute("data-injected")).toBe(false);
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ plausible: { enabled: false, trackingId: "example.com" } });

    expect(screen.queryAllByTestId("cal-analytics-app-plausible")).toHaveLength(0);
  });

  it("renders nothing without event type app configuration", () => {
    renderTagManager({});

    expect(screen.queryAllByTestId("cal-analytics-app-plausible")).toHaveLength(0);
  });
});

describe("PostHog analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(posthogHandler).toMatchObject({
      appType: posthogConfig.type,
      variant: posthogConfig.variant,
      slug: "posthog",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await posthogHandler.createCredential({
      appType: posthogHandler.appType,
      user: installUser,
      slug: posthogHandler.slug,
      teamId: 22,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: posthogConfig.type,
      user: installUser,
      slug: "posthog",
      key: {},
      teamId: 22,
    });
  });

  it("validates event type tracking settings", () => {
    expect(
      posthogAppDataSchema.parse({
        enabled: true,
        TRACKING_ID: "phc_test",
        API_HOST: "https://app.posthog.com",
      })
    ).toMatchObject({
      enabled: true,
      TRACKING_ID: "phc_test",
      API_HOST: "https://app.posthog.com",
    });
    expect(posthogAppDataSchema.safeParse({ enabled: true, TRACKING_ID: 123 }).success).toBe(false);
  });

  it("renders the PostHog initialization with the tracking ID and API host", () => {
    renderTagManager({
      posthog: {
        enabled: true,
        TRACKING_ID: "phc_test",
        API_HOST: "https://app.posthog.com",
      },
    });

    const scripts = screen.getAllByTestId("cal-analytics-app-posthog");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].outerHTML).toContain("posthog.init('phc_test',{api_host:'https://app.posthog.com'})");
  });

  it("keeps HTML-like tracking IDs inside the inline script", () => {
    renderTagManager({
      posthog: {
        enabled: true,
        TRACKING_ID: `<img src=x onerror="window.__xss=1">`,
        API_HOST: "https://app.posthog.com",
      },
    });

    expect(screen.getByTestId("cal-analytics-app-posthog").ownerDocument.querySelector("img")).toBeNull();
    expect(screen.getByTestId("cal-analytics-app-posthog").outerHTML).toContain("<img src=x");
  });

  it("renders nothing when disabled", () => {
    renderTagManager({
      posthog: { enabled: false, TRACKING_ID: "phc_test", API_HOST: "https://app.posthog.com" },
    });

    expect(screen.queryAllByTestId("cal-analytics-app-posthog")).toHaveLength(0);
  });
});

describe("Umami analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(umamiHandler).toMatchObject({
      appType: umamiConfig.type,
      variant: umamiConfig.variant,
      slug: "umami",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await umamiHandler.createCredential({
      appType: umamiHandler.appType,
      user: installUser,
      slug: umamiHandler.slug,
      teamId: 23,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: umamiConfig.type,
      user: installUser,
      slug: "umami",
      key: {},
      teamId: 23,
    });
  });

  it("validates event type tracking settings and defaults the script URL", () => {
    expect(umamiAppDataSchema.parse({ enabled: true, SITE_ID: "site-1" })).toMatchObject({
      enabled: true,
      SITE_ID: "site-1",
      SCRIPT_URL: "https://cloud.umami.is/script.js",
    });
    expect(
      umamiAppDataSchema.parse({
        enabled: true,
        SITE_ID: "site-1",
        SCRIPT_URL: "https://analytics.example.com/script.js",
      })
    ).toMatchObject({
      SCRIPT_URL: "https://analytics.example.com/script.js",
    });
    expect(umamiAppDataSchema.safeParse({ enabled: true, SITE_ID: 123 }).success).toBe(false);
  });

  it("renders the Umami script URL and website ID", () => {
    renderTagManager({
      umami: {
        enabled: true,
        SITE_ID: "site-1",
        SCRIPT_URL: "https://analytics.example.com/script.js",
      },
    });

    const scripts = screen.getAllByTestId("cal-analytics-app-umami");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe("https://analytics.example.com/script.js");
    expect(scripts[0].getAttribute("data-website-id")).toBe("site-1");
  });

  it("keeps the website ID inside the data-website-id attribute", () => {
    const siteId = `site-1" data-injected="yes`;

    renderTagManager({ umami: { enabled: true, SITE_ID: siteId } });

    const script = screen.getByTestId("cal-analytics-app-umami");
    expect(script.getAttribute("data-website-id")).toBe(siteId);
    expect(script.hasAttribute("data-injected")).toBe(false);
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ umami: { enabled: false, SITE_ID: "site-1" } });

    expect(screen.queryAllByTestId("cal-analytics-app-umami")).toHaveLength(0);
  });
});
