import { WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { PartialReference } from "@calcom/types/EventManager";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addWebex from "../api/add";
import callback from "../api/callback";
import WebexVideoApiAdapter from "../lib/VideoApiAdapter";

const CLIENT_ID = "webex-client-id";
const CLIENT_SECRET = "webex-client-secret";
const ACCESS_TOKEN = "webex-access-token";
const REFRESH_TOKEN = "webex-refresh-token";
const SCOPE = "spark:kms meeting:schedules_read meeting:schedules_write";
const CALLBACK_URL = `${WEBAPP_URL_FOR_OAUTH}/api/integrations/webex/callback`;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    user: { findFirstOrThrow: vi.fn() },
    app: { findUnique: vi.fn() },
    credential: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

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
  setHeader: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    setHeader: vi.fn(),
    writableEnded: false,
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
    url: "/api/integrations/webex/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildResponse = (body: Record<string, unknown>, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });

const translate = ((key: string) => key) as never;

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "Consultation",
  title: "Planning",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  organizer: {
    name: "Jane",
    email: "jane@example.com",
    timeZone: "UTC",
    language: { translate, locale: "en" },
  },
  attendees: [
    {
      name: "Alex",
      email: "alex@example.com",
      timeZone: "UTC",
      language: { translate, locale: "en" },
    },
  ],
  description: "Planning session",
  ...overrides,
});

const buildCredential = (overrides: Partial<CredentialPayload> = {}): CredentialPayload => ({
  id: 1,
  type: "webex_video",
  appId: "webex",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: "jane@example.com" },
  key: {
    scope: SCOPE,
    token_type: "Bearer",
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    refresh_token_expires_in: 7_776_000,
    expiry_date: Date.now() + 3_600_000,
  },
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  prisma.app.findUnique.mockResolvedValue({
    keys: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
  });
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: 1 });
  prisma.credential.findMany.mockResolvedValue([{ id: 5 }, { id: 6 }]);
  prisma.credential.create.mockResolvedValue({ id: 9 });
  prisma.credential.findUnique.mockResolvedValue({ id: 1 });
  prisma.credential.update.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Webex OAuth install", () => {
  it("sends the user to Webex with the meeting scopes and callback URL", async () => {
    const res = createResponse();

    await addWebex(buildRequest(), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://webexapis.com/v1/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      scope: SCOPE,
      state: "",
    });
    expect(prisma.user.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true },
    });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });
});

describe("Webex OAuth callback", () => {
  it("exchanges the code, replaces the previous Webex credential and stores the tokens", async () => {
    const tokenRequestStartedAt = Date.now();
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        token_type: "Bearer",
        scope: SCOPE,
        expires_in: 3_600,
        refresh_token_expires_in: 7_776_000,
      })
    );
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://webexapis.com/v1/access_token");
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: { "Content-type": "application/x-www-form-urlencoded" },
    });
    expect(Object.fromEntries(tokenOptions.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "auth-code",
      redirect_uri: CALLBACK_URL,
    });

    expect(prisma.credential.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: { type: "webex_video", userId: 1, appId: "webex" },
    });
    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [5, 6] }, userId: 1 },
    });

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { key: Record<string, unknown>; type: string; appId: string; userId: number };
    };
    expect(stored.data).toMatchObject({ type: "webex_video", appId: "webex", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      scope: SCOPE,
      refresh_token_expires_in: 7_776_000,
    });
    expect(stored.data.key.expires_in).toBeUndefined();
    expect(stored.data.key.expiry_date).toBeGreaterThanOrEqual(tokenRequestStartedAt + 3_590_000);
    expect(stored.data.key.expiry_date).toBeLessThanOrEqual(tokenRequestStartedAt + 3_610_000);

    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/conferencing?hl=webex");
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(
      JSON.stringify(stored.data.key)
    );
  });

  it("returns the Webex token error without creating a credential", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ message: "invalid_client" }, 400, "Bad Request"));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "invalid_client" });
    expect(prisma.credential.deleteMany).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("returns a message carried by a successful token response", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ message: "oauth state is missing" }));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "oauth state is missing" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session user", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN })
    );
    const res = createResponse();

    await callback(
      buildRequest({ query: { code: "auth-code" }, session: undefined }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "No user found" });
    expect(prisma.credential.deleteMany).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Webex video adapter", () => {
  it("creates a meeting with the Webex payload and returns its join URL and password", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        id: "meeting-1",
        webLink: "https://webex.example.com/meet/meeting-1",
        siteUrl: "https://webex.example.com",
        password: "pin-123",
      })
    );
    const adapter = WebexVideoApiAdapter(buildCredential());

    const result = await adapter?.createMeeting(buildEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://webexapis.com/v1/meetings");
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      title: "Planning",
      start: "2024-01-15T09:00:00Z",
      end: "2024-01-15T10:00:00Z",
      agenda: "Planning session",
      enableJoinBeforeHost: true,
      invitees: [{ email: "alex@example.com" }],
      sendEmail: true,
    });
    expect(result).toEqual({
      type: "webex_video",
      id: "meeting-1",
      password: "pin-123",
      url: "https://webex.example.com/meet/meeting-1",
    });
  });

  it("defaults the meeting password to an empty string", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        id: "meeting-1",
        webLink: "https://webex.example.com/meet/meeting-1",
        siteUrl: "https://webex.example.com",
      })
    );
    const adapter = WebexVideoApiAdapter(buildCredential());

    const result = await adapter?.createMeeting(buildEvent());

    expect(result?.password).toBe("");
  });

  it("updates the meeting by booking uid and keeps the booking reference meeting id", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        id: "server-meeting-id",
        webLink: "https://webex.example.com/meet/updated",
        siteUrl: "https://webex.example.com",
        password: "pin-456",
      })
    );
    const adapter = WebexVideoApiAdapter(buildCredential());
    const bookingRef: PartialReference = { type: "webex_video", uid: "booking-uid", meetingId: "meeting-1" };

    const result = await adapter?.updateMeeting(bookingRef, buildEvent());

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://webexapis.com/v1/meetings/booking-uid");
    expect(options).toMatchObject({
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(options.body as string)).toMatchObject({ title: "Planning" });
    expect(result).toEqual({
      type: "webex_video",
      id: "meeting-1",
      password: "pin-456",
      url: "https://webex.example.com/meet/updated",
    });
  });

  it("sends the delete request and keeps the baseline empty-body rejection", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, statusText: "No Content" }));
    const adapter = WebexVideoApiAdapter(buildCredential());

    // Cal.diy dereferences the empty 204 body, so a successful Webex delete reports failure.
    await expect(adapter?.deleteMeeting("meeting-1")).rejects.toThrow("Failed to delete meeting");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://webexapis.com/v1/meetings/meeting-1");
    expect(options).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  });

  it("invalidates the credential when Webex rejects the token", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ error: "invalid_grant" }, 401, "Unauthorized"));
    const adapter = WebexVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("Unauthorized");

    expect(prisma.credential.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { invalid: true },
    });
  });

  it("rejects a meeting response without a join URL", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({ id: "meeting-1", webLink: "", siteUrl: "https://webex.example.com" })
    );
    const adapter = WebexVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow(
      "Failed to create meeting: missing id or webLink in response"
    );
  });

  it("wraps a failed delete in the adapter error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const adapter = WebexVideoApiAdapter(buildCredential());

    await expect(adapter?.deleteMeeting("meeting-1")).rejects.toThrow("Failed to delete meeting");
  });
});
