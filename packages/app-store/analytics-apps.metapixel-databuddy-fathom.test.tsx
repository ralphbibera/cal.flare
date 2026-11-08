import type { RenderResult } from "@testing-library/react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultInstallation } from "./_utils/installation";
import BookingPageTagManager from "./BookingPageTagManager";
import databuddyHandler from "./databuddy/api/add";
import databuddyConfig from "./databuddy/config.json";
import { appDataSchema as databuddyAppDataSchema } from "./databuddy/zod";
import fathomHandler from "./fathom/api/add";
import fathomConfig from "./fathom/config.json";
import { appDataSchema as fathomAppDataSchema } from "./fathom/zod";
import metapixelHandler from "./metapixel/api/add";
import metapixelConfig from "./metapixel/config.json";
import { appDataSchema as metapixelAppDataSchema } from "./metapixel/zod";

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

const installUser = { id: 7 } as unknown as Parameters<typeof metapixelHandler.createCredential>[0]["user"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Meta Pixel analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(metapixelHandler).toMatchObject({
      appType: metapixelConfig.type,
      variant: metapixelConfig.variant,
      slug: "metapixel",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await metapixelHandler.createCredential({
      appType: metapixelHandler.appType,
      user: installUser,
      slug: metapixelHandler.slug,
      teamId: 31,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: metapixelConfig.type,
      user: installUser,
      slug: "metapixel",
      key: {},
      teamId: 31,
    });
  });

  it("validates event type tracking settings", () => {
    expect(
      metapixelAppDataSchema.parse({
        enabled: true,
        trackingId: "1234567890",
        trackingEvent: "Schedule",
      })
    ).toMatchObject({
      enabled: true,
      trackingId: "1234567890",
      trackingEvent: "Schedule",
    });
    expect(metapixelAppDataSchema.safeParse({ enabled: true, trackingId: 123 }).success).toBe(false);
    expect(metapixelAppDataSchema.safeParse({ enabled: true, trackingEvent: "NotARealEvent" }).success).toBe(
      false
    );
  });

  it("renders the pixel initialization and selected conversion event", () => {
    renderTagManager({
      metapixel: { enabled: true, trackingId: "1234567890", trackingEvent: "Schedule" },
    });

    const scripts = screen.getAllByTestId("cal-analytics-app-metapixel");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].outerHTML).toContain("fbq('init','1234567890')");
    expect(scripts[0].outerHTML).toContain("fbq('track','Schedule')");
  });

  it("defaults the conversion event to Lead", () => {
    renderTagManager({ metapixel: { enabled: true, trackingId: "1234567890" } });

    expect(screen.getByTestId("cal-analytics-app-metapixel").outerHTML).toContain("fbq('track','Lead')");
  });

  it("keeps HTML-like tracking IDs inside the inline script", () => {
    renderTagManager({
      metapixel: { enabled: true, trackingId: `<img src=x onerror="window.__xss=1">` },
    });

    expect(screen.getByTestId("cal-analytics-app-metapixel").ownerDocument.querySelector("img")).toBeNull();
    expect(screen.getByTestId("cal-analytics-app-metapixel").outerHTML).toContain("<img src=x");
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ metapixel: { enabled: false, trackingId: "1234567890" } });

    expect(screen.queryAllByTestId("cal-analytics-app-metapixel")).toHaveLength(0);
  });
});

describe("Databuddy analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(databuddyHandler).toMatchObject({
      appType: databuddyConfig.type,
      variant: databuddyConfig.variant,
      slug: "databuddy",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await databuddyHandler.createCredential({
      appType: databuddyHandler.appType,
      user: installUser,
      slug: databuddyHandler.slug,
      teamId: 32,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: databuddyConfig.type,
      user: installUser,
      slug: "databuddy",
      key: {},
      teamId: 32,
    });
  });

  it("validates event type tracking settings and defaults the script and API URLs", () => {
    expect(databuddyAppDataSchema.parse({ enabled: true, CLIENT_ID: "client-1" })).toMatchObject({
      enabled: true,
      CLIENT_ID: "client-1",
      DATABUDDY_SCRIPT_URL: "https://cdn.databuddy.cc/databuddy.js",
      DATABUDDY_API_URL: "https://basket.databuddy.cc",
    });
    expect(
      databuddyAppDataSchema.parse({
        enabled: true,
        CLIENT_ID: "client-1",
        DATABUDDY_SCRIPT_URL: "https://cdn.example.com/databuddy.js",
        DATABUDDY_API_URL: "https://api.example.com",
      })
    ).toMatchObject({
      DATABUDDY_SCRIPT_URL: "https://cdn.example.com/databuddy.js",
      DATABUDDY_API_URL: "https://api.example.com",
    });
    expect(databuddyAppDataSchema.safeParse({ enabled: true, CLIENT_ID: 123 }).success).toBe(false);
  });

  it("renders the Databuddy script URL, client ID and API URL", () => {
    renderTagManager({
      databuddy: {
        enabled: true,
        CLIENT_ID: "client-1",
        DATABUDDY_SCRIPT_URL: "https://cdn.example.com/databuddy.js",
        DATABUDDY_API_URL: "https://api.example.com",
      },
    });

    const scripts = screen.getAllByTestId("cal-analytics-app-databuddy");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe("https://cdn.example.com/databuddy.js");
    expect(scripts[0].getAttribute("data-client-id")).toBe("client-1");
    expect(scripts[0].getAttribute("data-api-url")).toBe("https://api.example.com");
  });

  it("keeps the client ID and API URL inside their attributes", () => {
    const clientId = `client-1" data-injected="yes`;
    const apiUrl = `https://api.example.com" data-other="yes`;

    renderTagManager({
      databuddy: { enabled: true, CLIENT_ID: clientId, DATABUDDY_API_URL: apiUrl },
    });

    const script = screen.getByTestId("cal-analytics-app-databuddy");
    expect(script.getAttribute("data-client-id")).toBe(clientId);
    expect(script.getAttribute("data-api-url")).toBe(apiUrl);
    expect(script.hasAttribute("data-injected")).toBe(false);
    expect(script.hasAttribute("data-other")).toBe(false);
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ databuddy: { enabled: false, CLIENT_ID: "client-1" } });

    expect(screen.queryAllByTestId("cal-analytics-app-databuddy")).toHaveLength(0);
  });
});

describe("Fathom analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(fathomHandler).toMatchObject({
      appType: fathomConfig.type,
      variant: fathomConfig.variant,
      slug: "fathom",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await fathomHandler.createCredential({
      appType: fathomHandler.appType,
      user: installUser,
      slug: fathomHandler.slug,
      teamId: 33,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: fathomConfig.type,
      user: installUser,
      slug: "fathom",
      key: {},
      teamId: 33,
    });
  });

  it("validates event type tracking settings", () => {
    expect(fathomAppDataSchema.parse({ enabled: true, trackingId: "SITEKEY" })).toMatchObject({
      enabled: true,
      trackingId: "SITEKEY",
    });
    expect(fathomAppDataSchema.safeParse({ enabled: true, trackingId: 123 }).success).toBe(false);
  });

  it("renders the Fathom script with the site ID", () => {
    renderTagManager({ fathom: { enabled: true, trackingId: "SITEKEY" } });

    const scripts = screen.getAllByTestId("cal-analytics-app-fathom");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe("https://cdn.usefathom.com/script.js");
    expect(scripts[0].getAttribute("data-site")).toBe("SITEKEY");
  });

  it("keeps the site ID inside the data-site attribute", () => {
    const trackingId = `SITEKEY" data-injected="yes`;

    renderTagManager({ fathom: { enabled: true, trackingId } });

    const script = screen.getByTestId("cal-analytics-app-fathom");
    expect(script.getAttribute("data-site")).toBe(trackingId);
    expect(script.hasAttribute("data-injected")).toBe(false);
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ fathom: { enabled: false, trackingId: "SITEKEY" } });

    expect(screen.queryAllByTestId("cal-analytics-app-fathom")).toHaveLength(0);
  });
});
