import type { CredentialPayload } from "@calcom/types/Credential";
import type { RenderResult } from "@testing-library/react";
import { cleanup, render, screen } from "@testing-library/react";
import type { NextApiRequest, NextApiResponse } from "next";
import type { ComponentProps } from "react";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultInstallation } from "./_utils/installation";
import BookingPageTagManager from "./BookingPageTagManager";
import dubAddHandler from "./dub/api/add";
import BuildAnalyticsService from "./dub/lib/AnalyticsService";
import { appDataSchema as dubAppDataSchema } from "./dub/zod";
import insihtsHandler from "./insihts/api/add";
import insihtsConfig from "./insihts/config.json";
import { appDataSchema as insihtsAppDataSchema } from "./insihts/zod";
import twiplaHandler from "./twipla/api/add";
import twiplaConfig from "./twipla/config.json";
import { appDataSchema as twiplaAppDataSchema } from "./twipla/zod";

const dubMocks: { trackLead: Mock; Dub: Mock } = vi.hoisted(() => {
  const trackLead = vi.fn();
  const Dub = vi.fn(function (this: { track: { lead: typeof trackLead } }) {
    this.track = { lead: trackLead };
  });
  return { trackLead, Dub };
});
const getAppKeysFromSlugMock: Mock = vi.hoisted(() => vi.fn());
const getParsedAppKeysFromSlugMock: Mock = vi.hoisted(() => vi.fn());

vi.mock("./_utils/installation", () => ({
  createDefaultInstallation: vi.fn(),
}));

vi.mock("./_utils/getAppKeysFromSlug", () => ({
  default: getAppKeysFromSlugMock,
}));

vi.mock("./_utils/getParsedAppKeysFromSlug", () => ({
  default: getParsedAppKeysFromSlugMock,
}));

vi.mock("dub-package", () => ({
  Dub: dubMocks.Dub,
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

type DubTestResponse = {
  status: Mock;
  json: Mock;
  setHeader: Mock;
  redirect: Mock;
  writableEnded: boolean;
};

function createDubRequest({ teamId }: { teamId?: string } = {}): NextApiRequest {
  return {
    method: "GET",
    url: "/api/apps/dub/add",
    query: teamId ? { teamId } : {},
    headers: {},
    session: { user: { id: 7, email: "host@example.com" } },
  } as unknown as NextApiRequest;
}

function createDubResponse(): DubTestResponse {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
    redirect: vi.fn(),
    writableEnded: false,
  };
  response.status.mockReturnThis();
  response.setHeader.mockReturnThis();
  return response;
}

const installUser = { id: 7 } as unknown as Parameters<typeof insihtsHandler.createCredential>[0]["user"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Insihts analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(insihtsHandler).toMatchObject({
      appType: insihtsConfig.type,
      variant: insihtsConfig.variant,
      slug: "insihts",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await insihtsHandler.createCredential({
      appType: insihtsHandler.appType,
      user: installUser,
      slug: insihtsHandler.slug,
      teamId: 41,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: insihtsConfig.type,
      user: installUser,
      slug: "insihts",
      key: {},
      teamId: 41,
    });
  });

  it("validates event type tracking settings", () => {
    expect(
      insihtsAppDataSchema.parse({
        enabled: true,
        SITE_ID: "site-1",
        SCRIPT_URL: "https://cdn.example.com/script.js",
      })
    ).toMatchObject({
      enabled: true,
      SITE_ID: "site-1",
      SCRIPT_URL: "https://cdn.example.com/script.js",
    });
    expect(insihtsAppDataSchema.safeParse({ enabled: true, SITE_ID: 123 }).success).toBe(false);
  });

  it("renders the built-in collector script with the website ID", () => {
    renderTagManager({
      insihts: {
        enabled: true,
        SITE_ID: "site-1",
        SCRIPT_URL: "https://cdn.example.com/script.js",
      },
    });

    const scripts = screen.getAllByTestId("cal-analytics-app-insihts");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe("https://collector.insihts.com/script.js");
    expect(scripts[0].getAttribute("data-website-id")).toBe("site-1");
  });

  it("keeps the website ID inside the data-website-id attribute", () => {
    const siteId = `site-1" data-injected="yes`;

    renderTagManager({ insihts: { enabled: true, SITE_ID: siteId } });

    const script = screen.getByTestId("cal-analytics-app-insihts");
    expect(script.getAttribute("data-website-id")).toBe(siteId);
    expect(script.hasAttribute("data-injected")).toBe(false);
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ insihts: { enabled: false, SITE_ID: "site-1" } });

    expect(screen.queryAllByTestId("cal-analytics-app-insihts")).toHaveLength(0);
  });

  it("renders nothing without event type app configuration", () => {
    renderTagManager({});

    expect(screen.queryAllByTestId("cal-analytics-app-insihts")).toHaveLength(0);
  });
});

describe("Twipla analytics app", () => {
  it("installs as a declarative app with an empty credential key", async () => {
    expect(twiplaHandler).toMatchObject({
      appType: twiplaConfig.type,
      variant: twiplaConfig.variant,
      slug: "twipla",
      supportsMultipleInstalls: false,
      handlerType: "add",
    });

    await twiplaHandler.createCredential({
      appType: twiplaHandler.appType,
      user: installUser,
      slug: twiplaHandler.slug,
      teamId: 42,
    });

    expect(createDefaultInstallation).toHaveBeenCalledWith({
      appType: twiplaConfig.type,
      user: installUser,
      slug: "twipla",
      key: {},
      teamId: 42,
    });
  });

  it("validates event type tracking settings", () => {
    expect(twiplaAppDataSchema.parse({ enabled: true, SITE_ID: "site-1" })).toMatchObject({
      enabled: true,
      SITE_ID: "site-1",
    });
    expect(twiplaAppDataSchema.safeParse({ enabled: true, SITE_ID: 123 }).success).toBe(false);
  });

  it("renders the Twipla script with the site ID", () => {
    renderTagManager({ twipla: { enabled: true, SITE_ID: "site-1" } });

    const scripts = screen.getAllByTestId("cal-analytics-app-twipla");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].outerHTML).toContain("app-worker.visitor-analytics.io/main.js");
    expect(scripts[0].outerHTML).toContain("'site-1'");
  });

  it("keeps HTML-like site IDs inside the inline script", () => {
    renderTagManager({
      twipla: { enabled: true, SITE_ID: `<img src=x onerror="window.__xss=1">` },
    });

    expect(screen.getByTestId("cal-analytics-app-twipla").ownerDocument.querySelector("img")).toBeNull();
    expect(screen.getByTestId("cal-analytics-app-twipla").outerHTML).toContain("<img src=x");
  });

  it("renders nothing when disabled", () => {
    renderTagManager({ twipla: { enabled: false, SITE_ID: "site-1" } });

    expect(screen.queryAllByTestId("cal-analytics-app-twipla")).toHaveLength(0);
  });

  it("renders nothing without event type app configuration", () => {
    renderTagManager({});

    expect(screen.queryAllByTestId("cal-analytics-app-twipla")).toHaveLength(0);
  });
});

describe("Dub analytics app", () => {
  it("builds the Dub OAuth authorization URL", async () => {
    getParsedAppKeysFromSlugMock.mockResolvedValue({
      client_id: "client-1",
      client_secret: "secret",
      redirect_uris: "https://example.com/api/integrations/dub/callback",
    });
    const res = createDubResponse();

    await dubAddHandler(createDubRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorizationUrl = new URL(url);
    expect(authorizationUrl.origin).toBe("https://app.dub.co");
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-1");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://example.com/api/integrations/dub/callback"
    );
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("scope")).toBe("workspaces.read");
    expect(authorizationUrl.searchParams.get("state")).toBeNull();
  });

  it("passes a team install through the OAuth state", async () => {
    getParsedAppKeysFromSlugMock.mockResolvedValue({
      client_id: "client-1",
      client_secret: "secret",
      redirect_uris: "https://example.com/api/integrations/dub/callback",
    });
    const res = createDubResponse();

    await dubAddHandler(createDubRequest({ teamId: "42" }), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    expect(JSON.parse(new URL(url).searchParams.get("state") ?? "null")).toEqual({ teamId: 42 });
  });

  it("has no event type app settings", () => {
    expect(dubAppDataSchema.parse({})).toEqual({});
    expect(dubAppDataSchema.parse({ enabled: true })).toEqual({});
  });

  it("does not render a booking page tag", () => {
    renderTagManager({ dub: {} });

    expect(screen.queryAllByTestId("cal-analytics-app-dub")).toHaveLength(0);
  });

  it("sends a Dub lead with the booking attribution fields", async () => {
    getAppKeysFromSlugMock.mockResolvedValue({ client_id: "client-1", client_secret: "secret" });
    const credential = {
      id: 1,
      userId: 7,
      key: {
        access_token: "token",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "workspaces.read",
        expiry_date: Date.now() + 60_000,
      },
    } as unknown as CredentialPayload;
    const service = BuildAnalyticsService(credential);

    await service.sendEvent({
      name: "Ada",
      email: "ada@example.com",
      eventName: "Demo",
      id: "click-1",
      externalId: "external-1",
    });

    expect(dubMocks.Dub).toHaveBeenCalledWith({ token: "token" });
    expect(dubMocks.trackLead).toHaveBeenCalledWith({
      clickId: "click-1",
      customerName: "Ada",
      customerEmail: "ada@example.com",
      externalId: "external-1",
      eventName: "Demo",
    });
  });

  it("falls back to the email as the Dub external ID", async () => {
    getAppKeysFromSlugMock.mockResolvedValue({ client_id: "client-1", client_secret: "secret" });
    const credential = {
      id: 1,
      userId: 7,
      key: { access_token: "token", expiry_date: Date.now() + 60_000 },
    } as unknown as CredentialPayload;
    const service = BuildAnalyticsService(credential);

    await service.sendEvent({
      name: "Ada",
      email: "ada@example.com",
      eventName: "Demo",
      id: "click-1",
    });

    expect(dubMocks.trackLead).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "ada@example.com" })
    );
  });

  it("does not send a Dub lead when app keys are missing", async () => {
    getAppKeysFromSlugMock.mockResolvedValue({});
    const credential = {
      id: 1,
      userId: 7,
      key: { access_token: "token", expiry_date: Date.now() + 60_000 },
    } as unknown as CredentialPayload;
    const service = BuildAnalyticsService(credential);

    await service.sendEvent({
      name: "Ada",
      email: "ada@example.com",
      eventName: "Demo",
      id: "click-1",
    });

    expect(dubMocks.Dub).not.toHaveBeenCalled();
    expect(dubMocks.trackLead).not.toHaveBeenCalled();
  });
});
