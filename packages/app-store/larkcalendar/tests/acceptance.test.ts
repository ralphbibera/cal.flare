import { WEBAPP_URL } from "@calcom/lib/constants";
import type { DestinationCalendar } from "@calcom/prisma/client";
import type { CalendarServiceEvent, Person } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "vitest-fetch-mock";

const { prisma, appAccessToken } = vi.hoisted(() => {
  // biome-ignore lint/style/noProcessEnv: vi.hoisted runs before imports
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.NEXTAUTH_SECRET = "lark-acceptance-secret";
  return {
    prisma: {
      app: { findUnique: vi.fn() },
      credential: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), findFirst: vi.fn() },
      selectedCalendar: { create: vi.fn() },
    },
    appAccessToken: vi.fn(),
  };
});

vi.mock("@calcom/prisma", () => ({ default: prisma }));
vi.mock("../lib/AppAccessToken", () => ({ getAppAccessToken: appAccessToken }));
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

const USER_ID = 7;
const EMAIL = "jane@example.com";
const ACCESS_TOKEN = "lark-user-access-token";
const REFRESH_TOKEN = "lark-user-refresh-token";
const APP_ACCESS_TOKEN = "lark-app-access-token";
const CALENDAR_ID = "lark-calendar-1";
const APP_KEYS = { app_id: "lark-app-id", app_secret: "lark-app-secret" };
const BASE = "https://open.larksuite.com/open-apis";
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
    url: "/api/integrations/larkcalendar/add",
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
    integration: "lark_calendar",
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
    type: "lark_calendar",
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
    appId: "lark-calendar",
    type: "lark_calendar",
    userId: USER_ID,
    user: { email: EMAIL },
    teamId: null,
    key: {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expiry_date: Math.floor(Date.now() / 1000) + 3600,
      refresh_expires_date: Math.floor(Date.now() / 1000) + 7200,
    },
    encryptedKey: null,
    invalid: false,
    delegationCredentialId: null,
    ...overrides,
  } as CredentialPayload;
}

function calendarEntry(
  calendarId: string,
  overrides: Partial<Record<"summary" | "summary_alias" | "permissions" | "type" | "role", string>> = {}
) {
  return {
    calendar_id: calendarId,
    summary: calendarId,
    summary_alias: "",
    permissions: "public",
    type: "primary",
    role: "owner",
    ...overrides,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    msg: "ok",
    data: {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expires_in: 3600,
      refresh_expires_in: 7200,
      ...overrides,
    },
  };
}

const callUrl = (index: number) => new URL(String(fetchMock.mock.calls[index][0]));
const callBody = (index: number) =>
  JSON.parse(String(fetchMock.mock.calls[index][1]?.body ?? "{}")) as Record<string, unknown>;
const callHeaders = (index: number) => fetchMock.mock.calls[index][1]?.headers as Record<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.resetMocks();
  prisma.app.findUnique.mockResolvedValue({ keys: APP_KEYS });
  prisma.selectedCalendar.create.mockResolvedValue({});
  prisma.credential.create.mockResolvedValue({ id: 10 });
  appAccessToken.mockResolvedValue(APP_ACCESS_TOKEN);
});

describe("Lark OAuth add", () => {
  it("returns the authorization URL and triggers an app ticket resend", async () => {
    const result = await addHandler(
      request({ query: { state: oauthState() } }),
      response() as unknown as NextApiResponse
    );

    const url = new URL((result as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/authen/v1/index`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ app_id: APP_KEYS.app_id });
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /^https?:\/\/.+\/api\/integrations\/larkcalendar\/callback$/
    );
    const state = JSON.parse(url.searchParams.get("state") ?? "{}");
    expect(state).toMatchObject({ returnTo: RETURN_TO });
    expect(state.nonce).toEqual(expect.any(String));
    expect(state.nonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect((result as { url: string }).url).not.toContain(APP_KEYS.app_secret);

    const resendUrl = callUrl(0);
    expect(`${resendUrl.origin}${resendUrl.pathname}`).toBe(`${BASE}/auth/v3/app_ticket/resend`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(callBody(0)).toEqual({ app_id: APP_KEYS.app_id, app_secret: APP_KEYS.app_secret });
  });
});

describe("Lark OAuth callback", () => {
  it("stores the user tokens and selects the primary calendar", async () => {
    fetchMock.mockResponseOnce(JSON.stringify(tokenResponse()));
    fetchMock.mockResponseOnce(
      JSON.stringify({ code: 0, data: { calendars: { calendar: { calendar_id: CALENDAR_ID } } } })
    );
    prisma.credential.findFirst.mockResolvedValue(null);
    const res = response();

    await callbackHandler(
      request({ query: { code: "auth-code", state: oauthState() } }),
      res as unknown as NextApiResponse
    );

    expect(`${callUrl(0).origin}${callUrl(0).pathname}`).toBe(`${BASE}/authen/v1/access_token`);
    expect(callHeaders(0).Authorization).toBe(`Bearer ${APP_ACCESS_TOKEN}`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(callBody(0)).toEqual({ grant_type: "authorization_code", code: "auth-code" });

    // Cal.diy stores the Lark token object as JSON in credential.key rather than encrypting it.
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; appId: string; userId: number; key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({ type: "lark_calendar", appId: "lark-calendar", userId: USER_ID });
    expect(stored.data.key).toEqual({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      expiry_date: expect.any(Number),
      refresh_expires_date: expect.any(Number),
    });

    expect(`${callUrl(1).origin}${callUrl(1).pathname}`).toBe(`${BASE}/calendar/v4/calendars/primary`);
    expect(callHeaders(1).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(prisma.selectedCalendar.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, integration: "lark_calendar", externalId: CALENDAR_ID },
    });
    expect(res.redirectedTo).toBe(RETURN_TO);
    expect(JSON.stringify(res)).not.toContain(ACCESS_TOKEN);
  });

  it("redirects with the provider error and stores nothing when the exchange fails", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ code: 10003, msg: "invalid code" }));
    const res = response();

    await callbackHandler(
      request({ query: { code: "bad-code", state: oauthState() } }),
      res as unknown as NextApiResponse
    );

    expect(res.redirectedTo).toBe('/apps/installed?error={"code":10003,"msg":"invalid code"}');
    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(prisma.credential.update).not.toHaveBeenCalled();
    expect(prisma.selectedCalendar.create).not.toHaveBeenCalled();
  });
});

describe("Lark token refresh", () => {
  it("refreshes an expired user token and persists the rotated pair", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify(
        tokenResponse({ access_token: "fresh-access-token", refresh_token: "fresh-refresh-token" })
      )
    );
    fetchMock.mockResponseOnce(
      JSON.stringify({
        code: 0,
        data: {
          calendar_list: [calendarEntry(CALENDAR_ID, { summary: "Work" })],
        },
      })
    );

    await BuildCalendarService(
      credential({
        key: {
          access_token: "expired-access-token",
          refresh_token: REFRESH_TOKEN,
          expiry_date: Math.floor(Date.now() / 1000) - 60,
          refresh_expires_date: Math.floor(Date.now() / 1000) + 7200,
        },
      })
    ).listCalendars();

    expect(`${callUrl(0).origin}${callUrl(0).pathname}`).toBe(`${BASE}/authen/v1/refresh_access_token`);
    expect(callHeaders(0).Authorization).toBe(`Bearer ${APP_ACCESS_TOKEN}`);
    expect(callBody(0)).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN });

    const update = prisma.credential.update.mock.calls[0][0] as {
      where: { id: number };
      data: { key: Record<string, unknown> };
    };
    expect(update.where).toEqual({ id: 1 });
    expect(update.data.key).toEqual({
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      expiry_date: expect.any(Number),
      refresh_expires_date: expect.any(Number),
    });
    expect(callHeaders(1).Authorization).toBe("Bearer fresh-access-token");
  });
});

describe("Lark calendar list", () => {
  it("keeps writable primary and shared calendars and maps their names", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        code: 0,
        data: {
          calendar_list: [
            calendarEntry(CALENDAR_ID, { summary: "Work", permissions: "show_only_free_busy" }),
            calendarEntry("shared-calendar", {
              summary: "Team",
              summary_alias: "Team alias",
              type: "shared",
              role: "writer",
            }),
            calendarEntry("private-calendar", { permissions: "private" }),
            calendarEntry("reader-calendar", { type: "shared", role: "reader" }),
            calendarEntry("google-calendar", { type: "google" }),
          ],
        },
      })
    );

    const calendars = await BuildCalendarService(credential()).listCalendars();

    expect(calendars.map(({ externalId, name, primary }) => ({ externalId, name, primary }))).toEqual([
      { externalId: CALENDAR_ID, name: "Work", primary: true },
      { externalId: "shared-calendar", name: "Team alias", primary: false },
    ]);
    expect(calendars.map(({ integration, email }) => ({ integration, email }))).toEqual([
      { integration: "lark_calendar", email: CALENDAR_ID },
      { integration: "lark_calendar", email: "shared-calendar" },
    ]);
    expect(`${callUrl(0).origin}${callUrl(0).pathname}`).toBe(`${BASE}/calendar/v4/calendars`);
    expect(callHeaders(0).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });
});

describe("Lark availability", () => {
  it("queries free/busy for the selected calendars and maps the busy slots", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        code: 0,
        data: {
          freebusy_list: [
            { calendar_id: CALENDAR_ID, start_time: START, end_time: END },
            { calendar_id: CALENDAR_ID, start_time: "2026-03-02T12:00:00Z", end_time: END },
          ],
          error_calendar_list: [],
        },
      })
    );

    const busy = await BuildCalendarService(credential()).getAvailability({
      dateFrom: "2026-03-02T00:00:00.000Z",
      dateTo: "2026-03-03T00:00:00.000Z",
      selectedCalendars: [
        { integration: "lark_calendar", externalId: CALENDAR_ID },
        { integration: "google_calendar", externalId: "google-calendar" },
      ],
      mode: "slots",
    });

    expect(`${callUrl(0).origin}${callUrl(0).pathname}`).toBe(`${BASE}/calendar/v4/freebusy/batch_get`);
    expect(callBody(0)).toEqual({
      time_min: "2026-03-02T00:00:00.000Z",
      time_max: "2026-03-03T00:00:00.000Z",
      calendar_ids: [CALENDAR_ID],
    });
    expect(busy).toEqual([
      { start: START, end: END },
      { start: "2026-03-02T12:00:00Z", end: END },
    ]);
  });
});

describe("Lark event writes", () => {
  it("creates the event on the calendar owned by the credential and adds attendees", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({ code: 0, data: { event: { event_id: "event-1", summary: "Product sync" } } })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ code: 0, data: { attendees: [] } }));

    const result = await BuildCalendarService(credential()).createEvent(
      event({
        destinationCalendar: [
          destinationCalendar("other-calendar", 999),
          destinationCalendar(CALENDAR_ID, 1),
        ],
        location: "integrations:zoom",
        team: { id: 1, name: "Team", members: [person("teammate@example.com"), person(EMAIL)] },
      }),
      1
    );

    expect(`${callUrl(0).origin}${callUrl(0).pathname}`).toBe(
      `${BASE}/calendar/v4/calendars/${CALENDAR_ID}/events/create_event`
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(callBody(0)).toMatchObject({
      summary: "Product sync",
      description: "Product sync",
      start_time: { timestamp: String(+new Date(START) / 1000), timezone: "UTC" },
      end_time: { timestamp: String(+new Date(END) / 1000), timezone: "UTC" },
      attendee_ability: "none",
      free_busy_status: "busy",
      reminders: [{ minutes: 5 }],
      location: { name: "Zoom" },
    });

    expect(`${callUrl(1).origin}${callUrl(1).pathname}`).toBe(
      `${BASE}/calendar/v4/calendars/${CALENDAR_ID}/events/event-1/attendees/create_attendees`
    );
    expect(callBody(1)).toEqual({
      attendees: [
        { type: "third_party", is_optional: false, third_party_email: "guest@example.com" },
        { type: "third_party", is_optional: false, third_party_email: "teammate@example.com" },
      ],
      need_notification: false,
    });
    expect(result).toMatchObject({ uid: "event-1", id: "event-1", type: "lark_calendar" });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });

  it("patches and deletes the event through the calendar endpoints", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({ code: 0, data: { event: { event_id: "event-1", summary: "Updated" } } })
    );
    const service = BuildCalendarService(credential());

    await service.updateEvent("event-1", event(), CALENDAR_ID);

    expect(`${callUrl(0).origin}${callUrl(0).pathname}`).toBe(
      `${BASE}/calendar/v4/calendars/${CALENDAR_ID}/events/event-1/patch_event`
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    expect(callBody(0)).toMatchObject({ summary: "Product sync" });

    fetchMock.mockResponseOnce(JSON.stringify({ code: 0, msg: "ok" }));
    await service.deleteEvent("event-1", event(), CALENDAR_ID);

    expect(`${callUrl(1).origin}${callUrl(1).pathname}`).toBe(
      `${BASE}/calendar/v4/calendars/${CALENDAR_ID}/events/event-1`
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("rejects writes without a calendar id and rethrows Lark API failures", async () => {
    const service = BuildCalendarService(credential());

    await expect(service.createEvent(event(), 1)).rejects.toThrow("no calendar id");
    await expect(service.updateEvent("event-1", event())).rejects.toThrow(/no calendar id/);
    await expect(service.deleteEvent("event-1", event())).rejects.toThrow(/no calendar id/);
    expect(fetchMock.mock.calls).toHaveLength(0);

    fetchMock.mockResponseOnce(JSON.stringify({ code: 190001, msg: "invalid event" }));
    await expect(
      service.createEvent(event({ destinationCalendar: [destinationCalendar()] }), 1)
    ).rejects.toEqual({ code: 190001, msg: "invalid event" });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});
