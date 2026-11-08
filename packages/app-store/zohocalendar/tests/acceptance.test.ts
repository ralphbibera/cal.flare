import { WEBAPP_URL } from "@calcom/lib/constants";
import type { DestinationCalendar } from "@calcom/prisma/client";
import type { CalendarServiceEvent, Person } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "vitest-fetch-mock";

const { prisma } = vi.hoisted(() => {
  // biome-ignore lint/style/noProcessEnv: vi.hoisted runs before imports
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.NEXTAUTH_SECRET = "zoho-acceptance-secret";
  // The service formats event times in the worker's local zone, which is UTC on Cloudflare.
  // biome-ignore lint/style/noProcessEnv: vi.hoisted runs before imports
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.TZ = "UTC";
  return {
    prisma: {
      app: { findUnique: vi.fn() },
      credential: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      selectedCalendar: { create: vi.fn() },
    },
  };
});

vi.mock("@calcom/prisma", () => ({ default: prisma }));
// The responder adds tracing and Sentry wrapping; the handler's own success and error paths are the subject.
vi.mock("@calcom/lib/server/defaultResponder", () => ({ defaultResponder: (handler: unknown) => handler }));
vi.mock("@calcom/lib/logger", () => ({
  default: {
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    getSubLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import addHandler from "../api/add";
import callbackHandler from "../api/callback";
import BuildCalendarService from "../lib/CalendarService";

const USER_ID = 42;
const EMAIL = "jane@example.com";
const ACCESS_TOKEN = "zoho-access-token";
const REFRESH_TOKEN = "zoho-refresh-token";
const CALENDAR_ID = "zoho-calendar-1";
const APP_KEYS = { client_id: "zoho-client-id", client_secret: "zoho-client-secret" };
const START = "2026-03-02T10:00:00.000Z";
const END = "2026-03-02T10:30:00.000Z";
const RETURN_TO = `${WEBAPP_URL}/apps/installed/calendar`;

type FakeResponse = {
  statusCode: number;
  body: unknown;
  redirectedTo: string | undefined;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
  redirect: (url: string) => FakeResponse;
};

function response(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    redirectedTo: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    redirect(url) {
      res.redirectedTo = url;
      return res;
    },
  };
  return res;
}

function request(overrides: Record<string, unknown> = {}): NextApiRequest {
  return {
    method: "GET",
    query: {},
    headers: {},
    url: "/api/integrations/zohocalendar/add",
    session: { user: { id: USER_ID } },
    ...overrides,
  } as unknown as NextApiRequest;
}

function oauthState(returnTo: string = RETURN_TO): string {
  return encodeOAuthState(
    request({
      query: {
        state: JSON.stringify({ returnTo, onErrorReturnTo: RETURN_TO, fromApp: false }),
      },
    })
  );
}

function person(email: string): Person {
  return {
    name: email,
    email,
    timeZone: "UTC",
    language: { translate: (key: string) => key, locale: "en" } as Person["language"],
  };
}

function destinationCalendar(
  externalId: string = CALENDAR_ID,
  credentialId: number = 1
): DestinationCalendar {
  return {
    id: 1,
    integration: "zoho_calendar",
    externalId,
    primaryEmail: null,
    userId: USER_ID,
    eventTypeId: null,
    credentialId,
    createdAt: new Date(START),
    updatedAt: null,
    delegationCredentialId: null,
    customCalendarReminder: null,
  };
}

function event(overrides: Partial<CalendarServiceEvent> = {}): CalendarServiceEvent {
  return {
    type: "zoho_calendar",
    title: "Product sync",
    startTime: START,
    endTime: END,
    organizer: person(EMAIL),
    attendees: [person("guest@example.com")],
    calendarDescription: "Product sync",
    ...overrides,
  };
}

function credential(overrides: Record<string, unknown> = {}): CredentialPayload {
  return {
    id: 1,
    appId: "zohocalendar",
    type: "zoho_calendar",
    userId: USER_ID,
    user: { email: EMAIL },
    teamId: null,
    key: {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: Math.floor(Date.now() / 1000) + 3600,
      server_location: "com",
    },
    encryptedKey: null,
    invalid: false,
    delegationCredentialId: null,
    ...overrides,
  } as CredentialPayload;
}

const callUrl = (index: number) => new URL(String(fetchMock.mock.calls[index][0]));
const callHeaders = (index: number) => fetchMock.mock.calls[index][1]?.headers as Record<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.resetMocks();
  prisma.app.findUnique.mockResolvedValue({ keys: APP_KEYS });
  prisma.selectedCalendar.create.mockResolvedValue({});
  prisma.credential.create.mockResolvedValue({ id: 10 });
});

describe("Zoho OAuth add", () => {
  it("builds the authorization URL with scopes, callback and a signed state", async () => {
    const res = response();

    await addHandler(request({ query: { state: oauthState() } }), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(200);
    const url = new URL((res.body as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.zoho.com/oauth/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: APP_KEYS.client_id,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
    });
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /^https?:\/\/.+\/api\/integrations\/zohocalendar\/callback$/
    );
    expect(url.searchParams.getAll("scope")).toEqual([
      "ZohoCalendar.calendar.ALL",
      "ZohoCalendar.event.ALL",
      "ZohoCalendar.freebusy.READ",
      "AaaServer.profile.READ",
    ]);
    const state = JSON.parse(url.searchParams.get("state") ?? "{}");
    expect(state).toMatchObject({ returnTo: RETURN_TO });
    expect(state.nonce).toEqual(expect.any(String));
    expect(state.nonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(url.toString()).not.toContain(APP_KEYS.client_secret);
  });
});

describe("Zoho OAuth callback", () => {
  it("exchanges the code, stores the token object and selects the default calendar", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ calendars: [{ uid: CALENDAR_ID, isdefault: true }] }));
    const res = response();

    await callbackHandler(
      request({ query: { code: "auth-code", location: "au", state: oauthState() } }),
      res as unknown as NextApiResponse
    );

    const tokenUrl = callUrl(0);
    expect(`${tokenUrl.origin}${tokenUrl.pathname}`).toBe("https://accounts.zoho.com.au/oauth/v2/token");
    expect(Object.fromEntries(tokenUrl.searchParams)).toMatchObject({
      grant_type: "authorization_code",
      client_id: APP_KEYS.client_id,
      client_secret: APP_KEYS.client_secret,
      code: "auth-code",
    });
    expect(tokenUrl.searchParams.get("redirect_uri")).toMatch(
      /^https?:\/\/.+\/api\/integrations\/zohocalendar\/callback$/
    );

    expect(`${callUrl(1).origin}${callUrl(1).pathname}`).toBe(
      "https://calendar.zoho.com.au/api/v1/calendars"
    );
    expect(callHeaders(1).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    // Cal.diy stores the Zoho token object as JSON in credential.key rather than encrypting it.
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: {
        type: string;
        appId: string;
        userId: number;
        key: { access_token: string; refresh_token: string; expires_in: number; server_location: string };
      };
    };
    expect(stored.data).toMatchObject({
      type: "zoho_calendar",
      appId: "zohocalendar",
      userId: USER_ID,
    });
    expect(stored.data.key).toEqual({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: expect.any(Number),
      server_location: "com.au",
    });

    expect(prisma.selectedCalendar.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, integration: "zoho_calendar", externalId: CALENDAR_ID, credentialId: 10 },
    });
    expect(res.redirectedTo).toBe(RETURN_TO);
    expect(JSON.stringify(res)).not.toContain(ACCESS_TOKEN);
  });

  it("redirects with the provider error and stores nothing when the exchange fails", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ error: "invalid_code" }), { status: 400 });
    const res = response();

    await callbackHandler(
      request({ query: { code: "bad-code", state: oauthState() } }),
      res as unknown as NextApiResponse
    );

    expect(res.redirectedTo).toBe('/apps/installed?error={"error":"invalid_code"}');
    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(prisma.selectedCalendar.create).not.toHaveBeenCalled();
  });
});

describe("Zoho token refresh", () => {
  it("rotates the access token while keeping the refresh token and server location", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ access_token: "fresh-access-token", expires_in: 1800 }));
    fetchMock.mockResponseOnce(
      JSON.stringify({
        calendars: [{ uid: CALENDAR_ID, name: "Work", isdefault: true, privilege: "owner" }],
      })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ Email: EMAIL }));

    await BuildCalendarService(
      credential({
        key: {
          access_token: "expired-access-token",
          refresh_token: REFRESH_TOKEN,
          expires_in: Math.floor(Date.now() / 1000) - 60,
          server_location: "eu",
        },
      })
    ).listCalendars();

    const refreshUrl = callUrl(0);
    expect(`${refreshUrl.origin}${refreshUrl.pathname}`).toBe("https://accounts.zoho.eu/oauth/v2/token");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(Object.fromEntries(refreshUrl.searchParams)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEYS.client_id,
      client_secret: APP_KEYS.client_secret,
    });

    const update = prisma.credential.update.mock.calls[0][0] as {
      where: { id: number };
      data: { key: Record<string, unknown> };
    };
    expect(update.where).toEqual({ id: 1 });
    expect(update.data.key).toEqual({
      access_token: "fresh-access-token",
      refresh_token: REFRESH_TOKEN,
      expires_in: expect.any(Number),
      server_location: "eu",
    });
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://calendar.zoho.eu/api/v1/calendars");
    expect(callHeaders(1).Authorization).toBe("Bearer fresh-access-token");
  });
});

describe("Zoho calendar list", () => {
  it("keeps only owned calendars and marks the default one primary", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        calendars: [
          { uid: CALENDAR_ID, name: "Work", isdefault: true, privilege: "owner" },
          { uid: "shared-calendar", name: "Team", isdefault: false, privilege: "shared" },
          { uid: "owned-secondary", name: "Side", isdefault: false, privilege: "owner" },
        ],
      })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ Email: EMAIL }));

    const calendars = await BuildCalendarService(credential()).listCalendars();

    expect(calendars).toEqual([
      { externalId: CALENDAR_ID, integration: "zoho_calendar", name: "Work", primary: true, email: EMAIL },
      {
        externalId: "owned-secondary",
        integration: "zoho_calendar",
        name: "Side",
        primary: false,
        email: EMAIL,
      },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://calendar.zoho.com/api/v1/calendars");
    expect(callHeaders(0).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://accounts.zoho.com/oauth/user/info");
  });
});

describe("Zoho availability", () => {
  it("merges free/busy slots with non-private calendar events", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ Email: EMAIL }));
    fetchMock.mockResponseOnce(
      JSON.stringify({
        freebusy: [
          { fbtype: "busy", startTime: "20260302T100000Z", endTime: "20260302T103000Z" },
          { fbtype: "free", startTime: "20260302T120000Z", endTime: "20260302T130000Z" },
        ],
      })
    );
    fetchMock.mockResponseOnce(
      JSON.stringify({
        events: [
          { isprivate: false, dateandtime: { start: "20260302T140000Z", end: "20260302T150000Z" } },
          { isprivate: true, dateandtime: { start: "20260302T160000Z", end: "20260302T170000Z" } },
        ],
      })
    );

    const busy = await BuildCalendarService(credential()).getAvailability({
      dateFrom: "2026-03-02T00:00:00.000Z",
      dateTo: "2026-03-09T00:00:00.000Z",
      selectedCalendars: [{ integration: "zoho_calendar", externalId: CALENDAR_ID }],
      mode: "slots",
    });

    expect(busy).toEqual([
      { start: "2026-03-02T10:00:00.000Z", end: "2026-03-02T10:30:00.000Z" },
      { start: "2026-03-02T14:00:00.000Z", end: "2026-03-02T15:00:00.000Z" },
    ]);

    const freeBusyUrl = callUrl(1);
    expect(`${freeBusyUrl.origin}${freeBusyUrl.pathname}`).toBe(
      "https://calendar.zoho.com/api/v1/calendars/freebusy"
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("GET");
    expect(freeBusyUrl.searchParams.get("sdate")).toBe("20260302T000000Z");
    expect(freeBusyUrl.searchParams.get("edate")).toBe("20260309T000000Z");
    expect(freeBusyUrl.searchParams.get("ftype")).toBe("eventbased");
    expect(freeBusyUrl.searchParams.get("uemail")).toBe(EMAIL);

    const eventsUrl = callUrl(2);
    expect(`${eventsUrl.origin}${eventsUrl.pathname}`).toBe(
      `https://calendar.zoho.com/api/v1/calendars/${CALENDAR_ID}/events`
    );
    expect(eventsUrl.searchParams.get("range")).toBe(
      JSON.stringify({ start: "20260302T000000Z", end: "20260309T000000Z" })
    );
  });
});

describe("Zoho event writes", () => {
  it("creates the event on the destination calendar and maps the response", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ events: [{ uid: "event-1", etag: "etag-1" }] }));

    const result = await BuildCalendarService(credential()).createEvent(
      event({
        destinationCalendar: [destinationCalendar()],
        location: "integrations:daily",
        hideCalendarEventDetails: true,
      }),
      1
    );

    const createUrl = callUrl(0);
    expect(`${createUrl.origin}${createUrl.pathname}`).toBe(
      `https://calendar.zoho.com/api/v1/calendars/${CALENDAR_ID}/events`
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(callHeaders(0).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(createUrl.searchParams.get("eventdata") ?? "{}")).toEqual({
      title: "Product sync",
      description: "Product sync",
      dateandtime: {
        start: "20260302T100000+0000",
        end: "20260302T103000+0000",
        timezone: "UTC",
      },
      attendees: [{ email: "guest@example.com" }],
      isprivate: true,
      reminders: [{ minutes: "-15", action: "popup" }],
      location: "Cal Video",
    });
    expect(result).toMatchObject({
      uid: "event-1",
      id: "event-1",
      type: "zoho_calendar",
      password: "",
      url: "",
      additionalInfo: {},
    });
  });

  it("updates with the fetched etag and deletes with it", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ events: [{ uid: "event-1", etag: "etag-1" }] }));
    fetchMock.mockResponseOnce(JSON.stringify({ events: [{ uid: "event-1", etag: "etag-2" }] }));
    const service = BuildCalendarService(credential());

    await service.updateEvent("event-1", event({ destinationCalendar: [destinationCalendar()] }));

    const updateUrl = callUrl(1);
    expect(`${updateUrl.origin}${updateUrl.pathname}`).toBe(
      `https://calendar.zoho.com/api/v1/calendars/${CALENDAR_ID}/events/event-1`
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PUT");
    expect(JSON.parse(updateUrl.searchParams.get("eventdata") ?? "{}")).toMatchObject({
      title: "Product sync",
      etag: "etag-1",
    });

    fetchMock.resetMocks();
    fetchMock.mockResponseOnce(JSON.stringify({ events: [{ uid: "event-1", etag: "etag-3" }] }));
    fetchMock.mockResponseOnce(JSON.stringify({}));

    await service.deleteEvent("event-1", event({ destinationCalendar: [destinationCalendar()] }));

    const deleteUrl = callUrl(1);
    expect(`${deleteUrl.origin}${deleteUrl.pathname}`).toBe(
      `https://calendar.zoho.com/api/v1/calendars/${CALENDAR_ID}/events/event-1`
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    expect(callHeaders(1).etag).toBe("etag-3");
  });

  it("rejects writes without a destination calendar and rethrows API failures", async () => {
    const service = BuildCalendarService(credential());

    await expect(service.createEvent(event(), 1)).rejects.toThrow("no calendar id");
    expect(fetchMock.mock.calls).toHaveLength(0);

    fetchMock.mockResponseOnce(JSON.stringify({ error: "INVALID_TOKEN" }), { status: 401 });
    await expect(service.listCalendars()).rejects.toEqual({ error: "INVALID_TOKEN" });
    expect(prisma.credential.delete).not.toHaveBeenCalled();
  });
});
