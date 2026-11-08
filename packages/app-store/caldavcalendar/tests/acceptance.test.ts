import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type { CalendarServiceEvent } from "@calcom/types/Calendar";
import type { NextApiRequest, NextApiResponse } from "next";
import {
  createAccount,
  createCalendarObject,
  deleteCalendarObject,
  fetchCalendarObjects,
  updateCalendarObject,
} from "tsdav";
import { beforeEach, describe, expect, it, vi } from "vitest";
import addCalDavCalendar from "../api/add";
import BuildCalendarService from "../lib/CalendarService";

const ENCRYPTION_KEY = "12345678901234567890123456789012";
const USERNAME = "jane@example.com";
const PASSWORD = "app-password";
const SERVER_URL = "https://cloud.example.com/remote.php/dav/";
const CALENDAR_URL = `${SERVER_URL}calendars/jane/work/`;
const OBJECT_URL = `${CALENDAR_URL}booking-1.ics`;

const { prisma, tsdavMocks } = vi.hoisted(() => {
  // biome-ignore lint/style/noProcessEnv: the calendar services read process.env at module load
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.CALENDSO_ENCRYPTION_KEY = "12345678901234567890123456789012";
  return {
    prisma: {
      user: { findFirstOrThrow: vi.fn(), findUnique: vi.fn() },
      credential: { create: vi.fn() },
    },
    tsdavMocks: {
      createAccount: vi.fn(),
      fetchCalendars: vi.fn(),
      fetchCalendarObjects: vi.fn(),
      createCalendarObject: vi.fn(),
      updateCalendarObject: vi.fn(),
      deleteCalendarObject: vi.fn(),
    },
  };
});

vi.mock("tsdav", async (importOriginal) => ({
  ...(await importOriginal<typeof import("tsdav")>()),
  ...tsdavMocks,
}));

vi.mock("@calcom/prisma", () => ({ default: prisma }));

vi.mock("@calcom/lib/logger", () => ({
  default: {
    error: vi.fn(),
    getSubLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  },
}));

const encrypt = (payload: Record<string, string>) =>
  symmetricEncrypt(JSON.stringify(payload), ENCRYPTION_KEY);

const buildCredential = () => ({
  id: 1,
  type: "caldav_calendar",
  appId: "caldav-calendar",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: USERNAME },
  key: encrypt({ username: USERNAME, password: PASSWORD, url: SERVER_URL }),
});

const buildEvent = (overrides: Partial<CalendarServiceEvent> = {}): CalendarServiceEvent => ({
  type: "caldav_calendar",
  title: "Planning",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  organizer: {
    name: "Jane",
    email: USERNAME,
    timeZone: "Europe/London",
    language: { translate: ((key: string) => key) as never, locale: "en" },
  },
  attendees: [],
  calendarDescription: "Planning session",
  ...overrides,
});

const AVAILABILITY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:summer
DTSTART;TZID=Europe/London:20240715T090000
DTEND;TZID=Europe/London:20240715T100000
SUMMARY:Summer review
END:VEVENT
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/London:20240102T140000
DTEND;TZID=Europe/London:20240102T143000
RRULE:FREQ=WEEKLY;COUNT=2
SUMMARY:Weekly sync
END:VEVENT
END:VCALENDAR`;

const REMOTE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:booking-1
DTSTART:20240115T090000Z
DTEND:20240115T100000Z
SUMMARY:Planning
END:VEVENT
END:VCALENDAR`;

type MockResponse = { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };

const createResponse = (): MockResponse => {
  const res: MockResponse = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const addRequest = (body: Record<string, unknown>) =>
  ({ method: "POST", body, session: { user: { id: 1 } } }) as unknown as NextApiRequest;

const BASIC_HEADER = {
  authorization: `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`,
};

beforeEach(() => {
  vi.resetAllMocks();
  tsdavMocks.createAccount.mockResolvedValue({ serverUrl: SERVER_URL });
  tsdavMocks.fetchCalendars.mockResolvedValue([
    { url: CALENDAR_URL, displayName: "Work", components: ["VEVENT"] },
  ]);
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: 1, email: USERNAME });
  prisma.credential.create.mockResolvedValue({});
});

describe("CalDAV credential add", () => {
  it("stores the encrypted server credentials without returning them", async () => {
    const res = createResponse();

    await addCalDavCalendar(
      addRequest({ username: USERNAME, password: PASSWORD, url: SERVER_URL }),
      res as NextApiResponse
    );

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; appId: string; userId: number; key: string };
    };
    expect(stored.data).toMatchObject({
      type: "caldav_calendar",
      appId: "caldav-calendar",
      userId: 1,
    });
    expect(stored.data.key).not.toContain(PASSWORD);
    expect(JSON.parse(symmetricDecrypt(stored.data.key, ENCRYPTION_KEY))).toEqual({
      username: USERNAME,
      password: PASSWORD,
      url: SERVER_URL,
    });
    expect(vi.mocked(createAccount)).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({
          serverUrl: SERVER_URL,
          credentials: { username: USERNAME, password: PASSWORD },
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/calendar?hl=caldav-calendar" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(stored.data.key);
  });

  it("explains the WebDAV Basic auth fix for a dav.php login failure", async () => {
    const davPhpUrl = "https://cloud.example.com:8443/remote.php/dav.php/";
    tsdavMocks.fetchCalendars.mockRejectedValue(new Error("Invalid credentials"));
    const res = createResponse();

    await addCalDavCalendar(
      addRequest({ username: USERNAME, password: PASSWORD, url: davPhpUrl }),
      res as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message:
        'Couldn\'t connect to caldav account, please verify WebDAV authentication type is set to "Basic"',
      actionUrl: "https://cloud.example.com:8443/admin/?/settings/standard/",
    });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("CalDAV availability", () => {
  it("parses recurring and timezone-aware events from the selected calendar", async () => {
    tsdavMocks.fetchCalendars.mockResolvedValue([
      { url: CALENDAR_URL, displayName: "Work", components: ["VEVENT"] },
      { url: `${SERVER_URL}calendars/jane/reminders/`, displayName: "Reminders", components: ["VTODO"] },
    ]);
    tsdavMocks.fetchCalendarObjects.mockResolvedValue([
      { url: OBJECT_URL, etag: '"etag-1"', data: AVAILABILITY_ICS },
    ]);
    const service = BuildCalendarService(buildCredential());

    const busy = await service.getAvailability({
      dateFrom: "2024-01-01T00:00:00Z",
      dateTo: "2024-07-20T00:00:00Z",
      selectedCalendars: [{ externalId: CALENDAR_URL, integration: "caldav_calendar" }],
      mode: "slots",
    });

    // Baseline expands recurring events from the availability range start, so occurrences
    // follow the range-start weekday rather than the VEVENT DTSTART (Jan 2). Matches Cal.diy.
    expect(busy).toEqual([
      { start: "2024-07-15T08:00:00.000Z", end: "2024-07-15T09:00:00.000Z" },
      { start: "2024-01-01T14:00:00.000Z", end: "2024-01-01T14:30:00.000Z" },
      { start: "2024-01-08T14:00:00.000Z", end: "2024-01-08T14:30:00.000Z" },
    ]);
    const call = vi.mocked(fetchCalendarObjects).mock.calls[0][0];
    expect(call.calendar.url).toBe(CALENDAR_URL);
    expect(call.expand).toBe(true);
    expect(call.timeRange).toEqual({
      start: "2024-01-01T00:00:00.000Z",
      end: "2024-07-20T00:00:00.000Z",
    });
    expect(call.urlFilter?.("https://cloud.example.com/event.ics")).toBe(true);
    expect(call.urlFilter?.("https://cloud.example.com/event.pdf")).toBe(false);
    expect(vi.mocked(fetchCalendarObjects)).toHaveBeenCalledTimes(1);
  });
});

describe("CalDAV event writes", () => {
  it("creates the booking on the credential server URL", async () => {
    tsdavMocks.createCalendarObject.mockResolvedValue(new Response(null, { status: 201 }));
    const service = BuildCalendarService(buildCredential());

    const result = await service.createEvent(buildEvent({ uid: "booking-1" }), 1);

    const call = vi.mocked(createCalendarObject).mock.calls[0][0];
    expect(call.calendar).toEqual({ url: CALENDAR_URL });
    expect(call.filename).toBe("booking-1.ics");
    expect(call.headers).toEqual(BASIC_HEADER);
    expect(call.iCalString).toContain("UID:booking-1");
    expect(call.iCalString).toContain("SCHEDULE-AGENT=CLIENT");
    expect(result).toMatchObject({ uid: "booking-1", id: "booking-1", type: "caldav_calendar" });
  });

  it("updates and deletes through the credential server URL", async () => {
    tsdavMocks.fetchCalendarObjects.mockResolvedValue([
      { url: OBJECT_URL, etag: '"etag-1"', data: REMOTE_ICS },
    ]);
    tsdavMocks.updateCalendarObject.mockResolvedValue(new Response(null, { status: 204 }));
    tsdavMocks.deleteCalendarObject.mockResolvedValue(new Response(null, { status: 204 }));
    const service = BuildCalendarService(buildCredential());

    await service.updateEvent("booking-1", buildEvent({ uid: "booking-1" }));
    await service.deleteEvent("booking-1", buildEvent({ uid: "booking-1" }));

    const updateCall = vi.mocked(updateCalendarObject).mock.calls[0][0];
    expect(updateCall.calendarObject).toMatchObject({ url: OBJECT_URL, etag: '"etag-1"' });
    expect(updateCall.calendarObject.data).toContain("UID:booking-1");
    expect(updateCall.headers).toEqual(BASIC_HEADER);
    expect(vi.mocked(deleteCalendarObject).mock.calls[0][0]).toEqual({
      calendarObject: { url: OBJECT_URL, etag: '"etag-1"' },
      headers: BASIC_HEADER,
    });
  });
});
