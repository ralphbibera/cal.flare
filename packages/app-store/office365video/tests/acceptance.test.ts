import { WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialForCalendarServiceWithTenantId } from "@calcom/types/Credential";
import type { PartialReference } from "@calcom/types/EventManager";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addOffice365Video from "../api/add";
import callback from "../api/callback";
import TeamsVideoApiAdapter from "../lib/VideoApiAdapter";

const CLIENT_ID = "msteams-client-id";
const CLIENT_SECRET = "msteams-client-secret";
const ACCESS_TOKEN = "graph-access-token";
const REFRESH_TOKEN = "graph-refresh-token";
const SCOPES = "OnlineMeetings.ReadWrite offline_access";
const CALLBACK_URL = `${WEBAPP_URL_FOR_OAUTH}/api/integrations/office365video/callback`;
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_MEETINGS_URL = "https://graph.microsoft.com/v1.0/me/onlineMeetings";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    app: { findUnique: vi.fn() },
    credential: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
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
    url: "/api/integrations/office365video/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const jsonResponse = (body: unknown, status = 200, statusText = "OK") =>
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
  uid: "booking-uid",
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
  ...overrides,
});

const buildCredential = (
  overrides: Partial<CredentialForCalendarServiceWithTenantId> = {}
): CredentialForCalendarServiceWithTenantId => ({
  id: 1,
  type: "office365_video",
  appId: "msteams",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  delegatedTo: null,
  user: { email: "jane@example.com" },
  key: {
    scope: SCOPES,
    token_type: "Bearer",
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expiry_date: Date.now() + 3_600_000,
  },
  ...overrides,
});

const meetingResponse = (overrides: Record<string, unknown> = {}) => ({
  id: "meeting-1",
  joinWebUrl: "https://teams.microsoft.com/l/meetup-join/meeting-1",
  joinUrl: "https://teams.microsoft.com/l/meetup-join/meeting-1",
  subject: "Planning",
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
  prisma.credential.findMany.mockResolvedValue([{ id: 5 }, { id: 6 }]);
  prisma.credential.create.mockResolvedValue({ id: 9 });
  prisma.credential.update.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Office 365 video OAuth install", () => {
  it("sends the user to Microsoft with the online meeting scopes and callback URL", async () => {
    const res = createResponse();

    await addOffice365Video(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.app.findUnique).toHaveBeenCalledWith({ where: { slug: "msteams" } });
    expect(res.status).toHaveBeenCalledWith(200);
    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      scope: SCOPES,
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      state: "",
    });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("rejects an install without an Office 365 client id", async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    const res = createResponse();

    await addOffice365Video(buildRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Office 365 client_id missing." });
  });
});

describe("Office 365 video OAuth callback", () => {
  it("exchanges the code, reads the Graph profile and replaces the previous credential", async () => {
    const tokenRequestStartedAt = Date.now();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        token_type: "Bearer",
        scope: SCOPES,
        expires_in: 3_600,
      })
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ mail: null, userPrincipalName: "jane@example.com" }));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(TOKEN_URL);
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    });
    expect(Object.fromEntries(new URLSearchParams(tokenOptions.body as string))).toEqual({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code: "auth-code",
      scope: SCOPES,
      redirect_uri: CALLBACK_URL,
      client_secret: CLIENT_SECRET,
    });

    const [profileUrl, profileOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(profileUrl).toBe("https://graph.microsoft.com/v1.0/me");
    expect(profileOptions).toMatchObject({
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(prisma.credential.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: { type: "office365_video", userId: 1, appId: "msteams" },
    });
    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [5, 6] }, userId: 1 },
    });

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { key: Record<string, unknown>; type: string; appId: string; userId: number };
    };
    expect(stored.data).toMatchObject({ type: "office365_video", appId: "msteams", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      scope: SCOPES,
      email: "jane@example.com",
    });
    expect(stored.data.key.expires_in).toBeUndefined();
    // Office 365 video stores expiry_date in seconds since the epoch, unlike the other video apps.
    expect(stored.data.key.expiry_date).toBeGreaterThanOrEqual(
      Math.floor(tokenRequestStartedAt / 1000) + 3_590
    );
    expect(stored.data.key.expiry_date).toBeLessThanOrEqual(Math.ceil(tokenRequestStartedAt / 1000) + 3_610);

    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/conferencing?hl=msteams");
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(
      JSON.stringify(stored.data.key)
    );
  });

  it("redirects a rejected token exchange with the provider error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant", error_description: "expired code" }, 400, "Bad Request")
    );
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(
      '/apps/installed?error={"error":"invalid_grant","error_description":"expired code"}'
    );
    expect(prisma.credential.deleteMany).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a code", async () => {
    const res = createResponse();

    await callback(buildRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "No code returned" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session user after reading the provider tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3_600 })
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ mail: "jane@example.com" }));
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

describe("Office 365 video adapter", () => {
  it("creates an online meeting with the Graph payload and returns its join URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(meetingResponse()));
    const adapter = TeamsVideoApiAdapter(buildCredential());

    const result = await adapter?.createMeeting(buildEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GRAPH_MEETINGS_URL);
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      startDateTime: "2024-01-15T09:00:00Z",
      endDateTime: "2024-01-15T10:00:00Z",
      subject: "Planning",
    });
    expect(result).toEqual({
      type: "office365_video",
      id: "meeting-1",
      password: "",
      url: "https://teams.microsoft.com/l/meetup-join/meeting-1",
    });
  });

  it("keeps the baseline requirement for both join URLs when creating a meeting", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "meeting-1",
        joinUrl: "https://teams.microsoft.com/l/meetup-join/meeting-1",
      })
    );
    const adapter = TeamsVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow(
      "Error creating MS Teams meeting: missing required fields in response"
    );
  });

  it("updates the meeting through the Graph online meeting endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        meetingResponse({ id: "meeting-1", joinWebUrl: "", joinUrl: "https://teams.microsoft.com/updated" })
      )
    );
    const adapter = TeamsVideoApiAdapter(buildCredential());
    const bookingRef: PartialReference = {
      type: "office365_video",
      uid: "booking-uid",
      meetingId: "meeting-1",
    };

    const result = await adapter?.updateMeeting(bookingRef, buildEvent());

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GRAPH_MEETINGS_URL);
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      startDateTime: "2024-01-15T09:00:00Z",
      endDateTime: "2024-01-15T10:00:00Z",
      subject: "Planning",
    });
    expect(result).toEqual({
      type: "office365_video",
      id: "meeting-1",
      password: "",
      url: "https://teams.microsoft.com/updated",
    });
  });

  it("resolves delete without calling Graph because the meeting link belongs to the event", async () => {
    const adapter = TeamsVideoApiAdapter(buildCredential());

    await expect(adapter?.deleteMeeting("meeting-1")).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token before creating the meeting and stores it", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "refreshed-access-token", token_type: "Bearer", expires_in: 3_600 })
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(meetingResponse()));
    const adapter = TeamsVideoApiAdapter(
      buildCredential({
        key: { access_token: "expired-access-token", refresh_token: REFRESH_TOKEN },
      })
    );

    await adapter?.createMeeting(buildEvent());

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(TOKEN_URL);
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(Object.fromEntries(new URLSearchParams(tokenOptions.body as string))).toEqual({
      scope: SCOPES,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    });

    const stored = prisma.credential.update.mock.calls[0][0] as {
      where: { id: number };
      data: { key: Record<string, unknown> };
    };
    expect(stored.where).toEqual({ id: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: "refreshed-access-token",
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
    });
    expect(stored.data.key.expires_in).toBeUndefined();

    const [meetingUrl, meetingOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(meetingUrl).toBe(GRAPH_MEETINGS_URL);
    expect(meetingOptions.headers).toMatchObject({ Authorization: "Bearer refreshed-access-token" });
  });

  it("wraps a rejected token refresh in the meeting error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, 400, "Bad Request"));
    const adapter = TeamsVideoApiAdapter(
      buildCredential({
        key: { access_token: "expired-access-token", refresh_token: REFRESH_TOKEN },
      })
    );

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow(
      "Error creating MS Teams meeting for booking booking-uid"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.credential.update).not.toHaveBeenCalled();
  });

  it("surfaces a Graph error status and text", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Forbidden" } }, 403, "Forbidden"));
    const adapter = TeamsVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("Forbidden");
  });

  it("wraps a failed create request in the adapter error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const adapter = TeamsVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow(
      "Error creating MS Teams meeting for booking booking-uid"
    );
  });
});
