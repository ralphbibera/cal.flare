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
import addAppleCalendar from "../api/add";
import BuildCalendarService from "../lib/CalendarService";

const ENCRYPTION_KEY = "12345678901234567890123456789012";
const USERNAME = "jane@example.com";
const PASSWORD = "app-password";
const CALENDAR_URL = "https://caldav.icloud.com/1/calendars/work/";
const OBJECT_URL = `${CALENDAR_URL}booking-1.ics`;

const { prisma, tsdavMocks } = vi.hoisted(() => {
  // biome-ignore lint/style/noProcessEnv: the calendar services read process.env at module load
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.CALENDSO_ENCRYPTION_KEY = "12345678901234567890123456789012";
  return {
    prisma: {
      user: { findFirstOrThrow: vi.fn(), findUnique: vi.fn() },
      credential: { upsert: vi.fn() },
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
  type: "apple_calendar",
  appId: "apple-calendar",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: USERNAME },
  key: encrypt({ username: USERNAME, password: PASSWORD }),
});

const buildEvent = (overrides: Partial<CalendarServiceEvent> = {}): CalendarServiceEvent => ({
  type: "apple_calendar",
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
  tsdavMocks.createAccount.mockResolvedValue({ serverUrl: "https://caldav.icloud.com" });
  tsdavMocks.fetchCalendars.mockResolvedValue([
    { url: CALENDAR_URL, displayName: "Work", components: ["VEVENT"] },
  ]);
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: 1, email: USERNAME, credentials: [] });
  prisma.credential.upsert.mockResolvedValue({});
});

describe("Apple Calendar credential add", () => {
  it("stores the encrypted credentials without returning them", async () => {
    const res = createResponse();

    await addAppleCalendar(addRequest({ username: USERNAME, password: PASSWORD }), res as NextApiResponse);

    const stored = prisma.credential.upsert.mock.calls[0][0] as {
      where: { id: number };
      create: { type: string; appId: string; userId: number; teamId: null; invalid: boolean; key: string };
    };
    expect(stored.where).toEqual({ id: -1 });
    expect(stored.create).toMatchObject({
      type: "apple_calendar",
      appId: "apple-calendar",
      userId: 1,
      teamId: null,
      invalid: false,
    });
    expect(stored.create.key).not.toContain(PASSWORD);
    expect(JSON.parse(symmetricDecrypt(stored.create.key, ENCRYPTION_KEY))).toEqual({
      username: USERNAME,
      password: PASSWORD,
    });
    expect(vi.mocked(createAccount)).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({
          serverUrl: "https://caldav.icloud.com",
          credentials: { username: USERNAME, password: PASSWORD },
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/calendar?hl=apple-calendar" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(stored.create.key);
  });

  it("rejects a second link with the same username and password", async () => {
    prisma.user.findFirstOrThrow.mockResolvedValue({
      id: 1,
      email: USERNAME,
      credentials: [{ id: 9, key: encrypt({ username: USERNAME, password: PASSWORD }) }],
    });
    const res = createResponse();

    await addAppleCalendar(addRequest({ username: USERNAME, password: PASSWORD }), res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: "account_already_linked" });
    expect(prisma.credential.upsert).not.toHaveBeenCalled();
    expect(tsdavMocks.fetchCalendars).not.toHaveBeenCalled();
  });

  it("updates the existing credential when only the password changes", async () => {
    prisma.user.findFirstOrThrow.mockResolvedValue({
      id: 1,
      email: USERNAME,
      credentials: [{ id: 9, key: encrypt({ username: USERNAME, password: "old-password" }) }],
    });
    const res = createResponse();

    await addAppleCalendar(addRequest({ username: USERNAME, password: PASSWORD }), res as NextApiResponse);

    const stored = prisma.credential.upsert.mock.calls[0][0] as {
      where: { id: number };
      update: { key: string };
    };
    expect(stored.where).toEqual({ id: 9 });
    expect(JSON.parse(symmetricDecrypt(stored.update.key, ENCRYPTION_KEY))).toEqual({
      username: USERNAME,
      password: PASSWORD,
    });
  });

  it("does not persist a credential when the CalDAV login check fails", async () => {
    tsdavMocks.fetchCalendars.mockRejectedValue(new Error("Unauthorized"));
    const res = createResponse();

    await addAppleCalendar(addRequest({ username: USERNAME, password: PASSWORD }), res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "unable_to_add_apple_calendar" });
    expect(prisma.credential.upsert).not.toHaveBeenCalled();
  });
});

describe("Apple Calendar event writes", () => {
  it("creates the booking on the iCloud CalDAV server", async () => {
    tsdavMocks.createCalendarObject.mockResolvedValue(new Response(null, { status: 201 }));
    const service = BuildCalendarService(buildCredential());

    const result = await service.createEvent(buildEvent({ uid: "booking-1" }), 1);

    const call = vi.mocked(createCalendarObject).mock.calls[0][0];
    expect(call.calendar).toEqual({ url: CALENDAR_URL });
    expect(call.filename).toBe("booking-1.ics");
    expect(call.headers).toEqual(BASIC_HEADER);
    expect(call.iCalString).toContain("UID:booking-1");
    expect(call.iCalString).toContain("BEGIN:VTIMEZONE");
    expect(call.iCalString).toContain("TZID:Europe/London");
    expect(call.iCalString).not.toContain("METHOD:PUBLISH");
    expect(call.iCalString).toContain("SCHEDULE-AGENT=CLIENT");
    expect(result).toMatchObject({ uid: "booking-1", id: "booking-1", type: "apple_calendar" });
  });

  it("updates the remote object with its URL and etag", async () => {
    tsdavMocks.fetchCalendarObjects.mockResolvedValue([
      { url: OBJECT_URL, etag: '"etag-1"', data: REMOTE_ICS },
    ]);
    tsdavMocks.updateCalendarObject.mockResolvedValue(new Response(null, { status: 204 }));
    const service = BuildCalendarService(buildCredential());

    await service.updateEvent("booking-1", buildEvent({ uid: "booking-1" }));

    expect(vi.mocked(fetchCalendarObjects).mock.calls[0][0].objectUrls).toEqual([OBJECT_URL]);
    const call = vi.mocked(updateCalendarObject).mock.calls[0][0];
    expect(call.calendarObject).toMatchObject({ url: OBJECT_URL, etag: '"etag-1"' });
    expect(call.calendarObject.data).toContain("UID:booking-1");
    expect(call.headers).toEqual(BASIC_HEADER);
  });

  it("deletes the remote object with its URL and etag", async () => {
    tsdavMocks.fetchCalendarObjects.mockResolvedValue([
      { url: OBJECT_URL, etag: '"etag-1"', data: REMOTE_ICS },
    ]);
    tsdavMocks.deleteCalendarObject.mockResolvedValue(new Response(null, { status: 204 }));
    const service = BuildCalendarService(buildCredential());

    await service.deleteEvent("booking-1", buildEvent({ uid: "booking-1" }));

    expect(vi.mocked(deleteCalendarObject).mock.calls[0][0]).toEqual({
      calendarObject: { url: OBJECT_URL, etag: '"etag-1"' },
      headers: BASIC_HEADER,
    });
  });
});
