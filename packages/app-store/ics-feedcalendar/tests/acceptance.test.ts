import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "vitest-fetch-mock";
import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type { CalendarServiceEvent } from "@calcom/types/Calendar";
import addIcsFeed from "../api/add";
import BuildCalendarService from "../lib/CalendarService";

const ENCRYPTION_KEY = "12345678901234567890123456789012";
const FEED_URL = "https://feeds.example.com/team.ics";
const SECOND_FEED_URL = "https://feeds.example.com/holidays.ics";
const THIRD_FEED_URL = "https://feeds.example.com/other.ics";

const { prisma } = vi.hoisted(() => {
  // biome-ignore lint/style/noProcessEnv: the calendar services read process.env at module load
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.CALENDSO_ENCRYPTION_KEY = "12345678901234567890123456789012";
  return {
    prisma: {
      user: { findFirstOrThrow: vi.fn(), findUnique: vi.fn() },
      credential: { create: vi.fn() },
    },
  };
});

vi.mock("@calcom/prisma", () => ({ default: prisma }));

vi.mock("@calcom/lib/logger", () => ({
  default: {
    error: vi.fn(),
    getSubLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  },
}));

const encrypt = (payload: { urls: string[] }) => symmetricEncrypt(JSON.stringify(payload), ENCRYPTION_KEY);

const buildCredential = (urls: string[] = [FEED_URL]) => ({
  id: 1,
  type: "ics-feed_calendar",
  appId: "ics-feed",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: "jane@example.com" },
  key: encrypt({ urls }),
});

const buildEvent = (overrides: Partial<CalendarServiceEvent> = {}): CalendarServiceEvent => ({
  type: "ics-feed_calendar",
  title: "Planning",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  organizer: {
    name: "Jane",
    email: "jane@example.com",
    timeZone: "Europe/London",
    language: { translate: ((key: string) => key) as never, locale: "en" },
  },
  attendees: [],
  calendarDescription: "Planning session",
  ...overrides,
});

const HEADER = "BEGIN:VCALENDAR\nVERSION:2.0\nX-WR-CALNAME:Team feed\n";

const VTIMEZONE = `BEGIN:VTIMEZONE
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
END:VTIMEZONE`;

const FEED_ICS = `${HEADER}${VTIMEZONE}
BEGIN:VEVENT
UID:summer
DTSTART;TZID=Europe/London:20240715T090000
DTEND;TZID=Europe/London:20240715T100000
SUMMARY:Summer review
END:VEVENT
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/London:20240101T140000
DTEND;TZID=Europe/London:20240101T143000
RRULE:FREQ=WEEKLY;COUNT=2
SUMMARY:Weekly sync
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

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.resetMocks();
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: 1, email: "jane@example.com" });
  prisma.credential.create.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ICS feed credential add", () => {
  it("stores the encrypted feed URLs without returning them", async () => {
    fetchMock.mockResponseOnce(FEED_ICS);
    const res = createResponse();

    await addIcsFeed(addRequest({ urls: [FEED_URL] }), res as NextApiResponse);

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; appId: string; key: string };
    };
    expect(stored.data).toMatchObject({ type: "ics-feed_calendar", appId: "ics-feed" });
    expect(stored.data.key).not.toContain(FEED_URL);
    expect(JSON.parse(symmetricDecrypt(stored.data.key, ENCRYPTION_KEY))).toEqual({ urls: [FEED_URL] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/calendar?hl=ics-feed" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(stored.data.key);
  });

  it("rejects the add when a feed cannot be parsed", async () => {
    fetchMock.mockResponseOnce(FEED_ICS);
    fetchMock.mockResponseOnce("this is not an iCalendar feed");
    const res = createResponse();

    await addIcsFeed(addRequest({ urls: [FEED_URL, SECOND_FEED_URL] }), res as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Could not add ICS feeds" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("ICS feed reading", () => {
  it("lists a readable calendar from each feed", async () => {
    fetchMock.mockResponseOnce(FEED_ICS);
    const service = BuildCalendarService(buildCredential());

    const calendars = await service.listCalendars();

    expect(calendars).toEqual([
      {
        name: "Team feed",
        readOnly: true,
        externalId: FEED_URL,
        integration: "ics-feed_calendar",
      },
    ]);
  });

  it("skips feeds that fail to load or parse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectOnce(new Error("feed offline"));
    fetchMock.mockResponseOnce("this is not an iCalendar feed");
    fetchMock.mockResponseOnce(FEED_ICS);
    const service = BuildCalendarService(buildCredential([FEED_URL, SECOND_FEED_URL, THIRD_FEED_URL]));

    const calendars = await service.listCalendars();

    expect(calendars).toHaveLength(1);
    expect(calendars[0].externalId).toBe(THIRD_FEED_URL);
  });

  it("parses recurring and timezone-aware busy times", async () => {
    fetchMock.mockResponseOnce(FEED_ICS);
    const service = BuildCalendarService(buildCredential());

    const busy = await service.getAvailability({
      dateFrom: "2024-01-01T00:00:00Z",
      dateTo: "2024-07-20T00:00:00Z",
      selectedCalendars: [{ externalId: FEED_URL, integration: "ics-feed_calendar" }],
      mode: "slots",
    });

    expect(busy).toEqual([
      { start: "2024-07-15T08:00:00.000Z", end: "2024-07-15T09:00:00.000Z", title: "Summer review" },
      { start: "2024-01-01T14:00:00.000Z", end: "2024-01-01T14:30:00.000Z", title: "Weekly sync" },
      { start: "2024-01-08T14:00:00.000Z", end: "2024-01-08T14:30:00.000Z", title: "Weekly sync" },
    ]);
  });

  it("does not attempt writes on a read-only feed", async () => {
    const service = BuildCalendarService(buildCredential());

    const created = await service.createEvent(buildEvent({ uid: "booking-1" }), 1);
    const updated = await service.updateEvent("booking-1", buildEvent({ uid: "booking-1" }));
    const deleted = await service.deleteEvent("booking-1", buildEvent({ uid: "booking-1" }));

    expect(created).toMatchObject({
      uid: "booking-1",
      id: "",
      type: "ics-feed_calendar",
      additionalInfo: { calWarnings: ["ICS feed is read-only"] },
    });
    expect(updated).toMatchObject({
      uid: "booking-1",
      id: "",
      type: "ics-feed_calendar",
      additionalInfo: { calWarnings: ["ICS feed is read-only"] },
    });
    expect(deleted).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
