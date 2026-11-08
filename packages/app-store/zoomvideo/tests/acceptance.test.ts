import { WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { PartialReference } from "@calcom/types/EventManager";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addZoom from "../api/add";
import callback from "../api/callback";
import ZoomVideoApiAdapter from "../lib/VideoApiAdapter";

const CLIENT_ID = "zoom-client-id";
const CLIENT_SECRET = "zoom-client-secret";
const ACCESS_TOKEN = "zoom-access-token";
const REFRESH_TOKEN = "zoom-refresh-token";
const CALLBACK_URL = `${WEBAPP_URL_FOR_OAUTH}/api/integrations/zoomvideo/callback`;
const SETTINGS_URL =
  "https://api.zoom.us/v2/users/me/settings?custom_query_fields=default_password_for_scheduled_meetings,meeting_password_requirement,auto_recording,waiting_room";

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
    url: "/api/integrations/zoomvideo/add",
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
  organizer: {
    name: "Jane",
    email: "jane@example.com",
    timeZone: "Europe/London",
    language: { translate, locale: "en" },
  },
  attendees: [
    {
      name: "Alex",
      email: "alex@example.com",
      timeZone: "Europe/London",
      language: { translate, locale: "en" },
    },
  ],
  description: "Planning session",
  ...overrides,
});

const buildCredential = (overrides: Partial<CredentialPayload> = {}): CredentialPayload => ({
  id: 1,
  type: "zoom_video",
  appId: "zoom",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: "jane@example.com" },
  key: {
    scope: "meeting:write",
    token_type: "Bearer",
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expiry_date: Date.now() + 3_600_000,
  },
  ...overrides,
});

const meetingResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 91234567890,
  join_url: "https://zoom.us/j/91234567890",
  password: "pin-123",
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

describe("Zoom OAuth install", () => {
  it("sends the user to Zoom with the client id and callback URL", async () => {
    const res = createResponse();

    await addZoom(buildRequest(), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://zoom.us/oauth/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      state: "",
    });
    expect(prisma.user.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true },
    });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });
});

describe("Zoom OAuth callback", () => {
  it("exchanges the code, replaces the previous Zoom credential and stores the tokens", async () => {
    const tokenRequestStartedAt = Date.now();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        token_type: "Bearer",
        scope: "meeting:write",
        expires_in: 3_600,
      })
    );
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    // encodeURI leaves the callback's scheme and slashes unescaped, as the baseline did.
    expect(tokenUrl).toBe(
      "https://zoom.us/oauth/token?grant_type=authorization_code&code=auth-code&redirect_uri=http://localhost:3000/api/integrations/zoomvideo/callback"
    );
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
    });
    expect(tokenOptions.body).toBeUndefined();

    expect(prisma.credential.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: { type: "zoom_video", userId: 1, appId: "zoom" },
    });
    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [5, 6] }, userId: 1 },
    });

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { key: Record<string, unknown>; type: string; appId: string; userId: number };
    };
    expect(stored.data).toMatchObject({ type: "zoom_video", appId: "zoom", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      scope: "meeting:write",
    });
    expect(stored.data.key.expires_in).toBeUndefined();
    expect(stored.data.key.expiry_date).toBeGreaterThanOrEqual(tokenRequestStartedAt + 3_590_000);
    expect(stored.data.key.expiry_date).toBeLessThanOrEqual(tokenRequestStartedAt + 3_610_000);

    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/conferencing?hl=zoom");
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(
      JSON.stringify(stored.data.key)
    );
  });

  it("returns the Zoom token error without creating a credential", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_client" }, 400, "Bad Request"));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "invalid_client" });
    expect(prisma.credential.deleteMany).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("returns an error carried by a successful token response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "oauth state is missing" }));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "oauth state is missing" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session user", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN })
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

describe("Zoom video adapter", () => {
  it("creates a meeting with the Zoom payload and returns its join URL and password", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockResolvedValueOnce(jsonResponse(meetingResponse()));
    const adapter = ZoomVideoApiAdapter(buildCredential());

    const result = await adapter?.createMeeting(buildEvent());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [settingsUrl, settingsOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(settingsUrl).toBe(SETTINGS_URL);
    expect(settingsOptions).toMatchObject({
      method: "GET",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const [url, options] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.zoom.us/v2/users/me/meetings");
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      topic: "Planning",
      type: 2,
      start_time: "2024-01-15T09:00:00",
      duration: 60,
      timezone: "Europe/London",
      agenda: "Planning session",
      settings: {
        host_video: true,
        participant_video: true,
        cn_meeting: false,
        in_meeting: false,
        join_before_host: true,
        mute_upon_entry: false,
        watermark: false,
        use_pmi: false,
        approval_type: 2,
        audio: "both",
        auto_recording: "none",
        enforce_login: false,
        registrants_email_notification: true,
        waiting_room: false,
      },
    });
    expect(result).toEqual({
      type: "zoom_video",
      id: "91234567890",
      password: "pin-123",
      url: "https://zoom.us/j/91234567890",
    });
  });

  it("defaults the meeting password to an empty string", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 91234567890, join_url: "https://zoom.us/j/91234567890" })
    );
    const adapter = ZoomVideoApiAdapter(buildCredential());

    const result = await adapter?.createMeeting(buildEvent());

    expect(result?.password).toBe("");
  });

  it("updates the meeting by booking uid and returns the refreshed meeting details", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, statusText: "No Content" }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(meetingResponse({ join_url: "https://zoom.us/j/updated", password: "pin-456" }))
    );
    const adapter = ZoomVideoApiAdapter(buildCredential());
    const bookingRef: PartialReference = { type: "zoom_video", uid: "booking-uid", meetingId: "meeting-1" };

    const result = await adapter?.updateMeeting(bookingRef, buildEvent());

    const [patchUrl, patchOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toBe("https://api.zoom.us/v2/meetings/booking-uid");
    expect(patchOptions).toMatchObject({
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(patchOptions.body as string)).toMatchObject({ topic: "Planning", type: 2 });

    const [getUrl, getOptions] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(getUrl).toBe("https://api.zoom.us/v2/meetings/booking-uid");
    expect(getOptions).toMatchObject({
      method: "GET",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(result).toEqual({
      type: "zoom_video",
      id: "91234567890",
      password: "pin-456",
      url: "https://zoom.us/j/updated",
    });
  });

  it("deletes the meeting by uid", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, statusText: "No Content" }));
    const adapter = ZoomVideoApiAdapter(buildCredential());

    await expect(adapter?.deleteMeeting("meeting-1")).resolves.toBeUndefined();

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.zoom.us/v2/meetings/meeting-1");
    expect(options).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(options.body).toBeUndefined();
  });

  it("refreshes an expired token before using it and stores the merged token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "refreshed-access-token", token_type: "Bearer", expires_in: 3_600 })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        next_page_token: "",
        page_count: 0,
        page_number: 1,
        page_size: 300,
        total_records: 0,
        meetings: [],
      })
    );
    const adapter = ZoomVideoApiAdapter(
      buildCredential({ key: { access_token: "expired-access-token", refresh_token: REFRESH_TOKEN } })
    );

    await expect(adapter?.getAvailability()).resolves.toEqual([]);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://zoom.us/oauth/token");
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    expect(Object.fromEntries(tokenOptions.body as URLSearchParams)).toEqual({
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
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
    expect(stored.data.key.expiry_date).toBeGreaterThan(Date.now());
    expect(stored.data.key.expires_in).toBeUndefined();

    const [meetingsUrl, meetingsOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(meetingsUrl).toBe("https://api.zoom.us/v2/users/me/meetings?type=scheduled&page_size=300");
    expect(meetingsOptions.headers).toMatchObject({ Authorization: "Bearer refreshed-access-token" });
  });

  it("invalidates the credential when Zoom rejects the refresh token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, 400, "Bad Request"));
    const adapter = ZoomVideoApiAdapter(
      buildCredential({ key: { access_token: "expired-access-token", refresh_token: REFRESH_TOKEN } })
    );

    await expect(adapter?.getAvailability()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.credential.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { invalid: true },
    });
  });

  it("expires the access token when Zoom rejects it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 124, message: "Invalid access token" }, 401, "Unauthorized")
    );
    const adapter = ZoomVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("Unexpected error");

    const stored = prisma.credential.update.mock.calls[0][0] as { data: { key: Record<string, unknown> } };
    expect(stored.data.key.expiry_date).toBeLessThan(Date.now());
  });

  it("rejects a meeting response without a join URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 91234567890 }));
    const adapter = ZoomVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("Unexpected error");
  });

  it("wraps a failed update and delete in the adapter error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const adapter = ZoomVideoApiAdapter(buildCredential());

    await expect(adapter?.updateMeeting({ uid: "booking-uid" }, buildEvent())).rejects.toThrow(
      "Failed to update meeting"
    );
    await expect(adapter?.deleteMeeting("meeting-1")).rejects.toThrow("Failed to delete meeting");
  });
});
