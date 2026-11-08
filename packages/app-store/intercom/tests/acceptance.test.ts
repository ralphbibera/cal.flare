import process from "node:process";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import callback from "../api/callback";
import configure from "../api/configure";
import get from "../api/get";
import initialize from "../api/initialize";
import sheet from "../api/sheet";

const CLIENT_ID = "intercom-client-id";
const CLIENT_SECRET = "intercom-client-secret";
const ACCESS_TOKEN = "intercom-access-token";
const ADMIN_ID = "admin-1";
const APP_URL = "http://app.cal.local:3000";
const STATE_SECRET = "intercom-state-secret";

const { prisma, createOAuthAppCredential, getAppKeys } = vi.hoisted(() => ({
  prisma: {
    credential: { deleteMany: vi.fn(), findFirst: vi.fn() },
    eventType: { findMany: vi.fn() },
    team: { findUnique: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn() },
  },
  createOAuthAppCredential: vi.fn(),
  getAppKeys: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("../../_utils/getAppKeysFromSlug", () => ({ default: getAppKeys }));
vi.mock("../../_utils/oauth/createOAuthAppCredential", () => ({ default: createOAuthAppCredential }));
vi.mock("@calcom/lib/logger", () => {
  const getSubLogger = () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    getSubLogger,
  });
  return { default: { ...getSubLogger(), getSubLogger } };
});

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    send: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    body: {},
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXTAUTH_SECRET = STATE_SECRET;
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  prisma.credential.deleteMany.mockResolvedValue({ count: 0 });
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.eventType.findMany.mockResolvedValue([]);
  prisma.team.findUnique.mockResolvedValue(null);
  prisma.user.findUnique.mockResolvedValue({ id: 1, username: "jane" });
  getAppKeys.mockResolvedValue({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Intercom OAuth install", () => {
  it("sends the user to Intercom with the signed state and no client secret", async () => {
    const res = createResponse();

    await add(
      buildRequest({ query: { state: JSON.stringify({ returnTo: "/apps/installed/automation" }) } }),
      res as unknown as NextApiResponse
    );

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://app.intercom.com/oauth");
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/integrations/intercom/callback"
    );
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(JSON.parse(authorize.searchParams.get("state") ?? "{}")).toMatchObject({
      returnTo: "/apps/installed/automation",
      nonce: expect.any(String),
      nonceHash: expect.any(String),
    });
    expect(url).not.toContain(CLIENT_SECRET);
  });

  it("exchanges the code, stores the admin token, and replaces a prior admin credential", async () => {
    fetchMock
      .mockResolvedValueOnce(buildResponse({ access_token: ACCESS_TOKEN }))
      .mockResolvedValueOnce(buildResponse({ id: ADMIN_ID }));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://api.intercom.io/auth/eagle/token");
    expect(JSON.parse(tokenOptions.body as string)).toEqual({
      code: "auth-code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const [adminUrl, adminOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(adminUrl).toBe("https://api.intercom.io/me");
    expect(adminOptions).toMatchObject({ headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });

    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({
      where: { type: "intercom_automation", key: { string_contains: ADMIN_ID } },
    });
    expect(createOAuthAppCredential).toHaveBeenCalledWith(
      { appId: "intercom", type: "intercom_automation" },
      JSON.stringify({ access_token: ACCESS_TOKEN, admin_id: ADMIN_ID }),
      expect.anything()
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/apps/installed/automation?hl=intercom")
    );
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(ACCESS_TOKEN);
  });

  it("redirects with the token error and creates no credential", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ error: "invalid_code" }, 401));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "bad-code" } }), res as unknown as NextApiResponse);

    expect(res.redirect).toHaveBeenCalledWith(
      `/apps/installed?error=${JSON.stringify({ error: "invalid_code" })}`
    );
    expect(createOAuthAppCredential).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session user", async () => {
    const res = createResponse();

    await callback(
      buildRequest({ query: { code: "auth-code" }, session: undefined }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Intercom canvas endpoints", () => {
  it("builds the booking canvas from the card creation options", async () => {
    const res = createResponse();

    await initialize(
      buildRequest({
        method: "POST",
        body: {
          card_creation_options: { submit_booking_url: "https://cal.com/jane/30min" },
        },
      }),
      res as unknown as NextApiResponse
    );

    const canvas = res.json.mock.calls[0][0] as {
      canvas: { content: { components: Array<Record<string, unknown>> } };
    };
    expect(canvas.canvas.content.components).toHaveLength(2);
    expect(canvas.canvas.content.components[0]).toMatchObject({
      type: "text",
      text: "Schedule a meeting with me",
      style: "header",
    });
    expect(canvas.canvas.content.components[1]).toMatchObject({
      type: "button",
      id: "submit-issue-form",
      action: {
        type: "sheet",
        url: `${APP_URL}/api/integrations/intercom/get?url=${encodeURIComponent("https://cal.com/jane/30min")}`,
      },
    });
  });

  it("returns the stored booking URL and the button step canvas", async () => {
    const res = createResponse();

    await configure(
      buildRequest({
        method: "POST",
        body: {
          input_values: { invitation_text: "Book a call", booking_button_text: "Book" },
          current_canvas: { stored_data: { submit_booking_url: "https://cal.com/jane/30min" } },
        },
      }),
      res as unknown as NextApiResponse
    );

    const canvas = res.json.mock.calls[0][0] as {
      canvas: {
        content: { components: Array<Record<string, unknown>> };
        stored_data: Record<string, unknown>;
      };
    };
    expect(canvas.canvas.stored_data).toEqual({ submit_booking_url: "https://cal.com/jane/30min" });
    expect(canvas.canvas.content.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "invitation_input", value: "Schedule a meeting with me" }),
        expect.objectContaining({ id: "booking_button_input", value: "Book now" }),
      ])
    );
  });

  it("renders the embed HTML for a cal.com URL and rejects other hosts", async () => {
    const res = createResponse();

    await get(
      buildRequest({ method: "POST", query: { url: "https://cal.com/jane/30min" } }),
      res as unknown as NextApiResponse
    );

    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('Cal("init", { origin: "https://cal.com" })');
    expect(html).toContain('calLink: "jane/30min"');
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/html");

    const rejected = createResponse();
    await get(
      buildRequest({ method: "POST", query: { url: "https://evil.example.com/jane/30min" } }),
      rejected as unknown as NextApiResponse
    );
    expect(rejected.status).toHaveBeenCalledWith(400);
    expect(rejected.json).toHaveBeenCalledWith({
      message: "URL must be for cal.com or a subdomain of cal.com",
    });
  });

  it("returns the booking recap canvas", async () => {
    const res = createResponse();

    await sheet(
      buildRequest({
        method: "POST",
        body: {
          sheet_values: {
            booking: { startTime: "2024-01-15T09:00:00Z" },
            eventType: { title: "Planning" },
            organizer: { name: "Jane", timeZone: "UTC" },
          },
        },
      }),
      res as unknown as NextApiResponse
    );

    const canvas = res.json.mock.calls[0][0] as {
      canvas: { content: { components: Array<Record<string, unknown>> } };
    };
    expect(canvas.canvas.content.components[0]).toMatchObject({
      type: "text",
      text: "Confirmed: Planning",
      style: "header",
    });
    expect(canvas.canvas.content.components[2]).toMatchObject({
      type: "text",
      text: expect.stringContaining("You are scheduled with Jane on"),
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
