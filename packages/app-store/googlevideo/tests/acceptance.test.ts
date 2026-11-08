// @vitest-environment jsdom
import "vitest-fetch-mock";
import { MeetLocationType } from "@calcom/app-store/constants";
import type { CalendarServiceEvent } from "@calcom/types/Calendar";
import type { CredentialForCalendarServiceWithEmail } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVideoAdapters } from "../../getVideoAdapters";
import BuildCalendarService from "../../googlecalendar/lib/CalendarService";
import { metadata } from "../_metadata";
import installGoogleMeet from "../api/_getAdd";

const { prisma, getGoogleAppKeysMock } = vi.hoisted(() => ({
  prisma: {
    credential: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
  getGoogleAppKeysMock: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

vi.mock("@calcom/lib/logger", () => {
  const getSubLogger = () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    silly: vi.fn(),
    warn: vi.fn(),
    getSubLogger,
  });
  return { default: { ...getSubLogger(), getSubLogger } };
});

vi.mock("../../googlecalendar/lib/getGoogleAppKeys", () => ({
  getGoogleAppKeys: getGoogleAppKeysMock,
}));

vi.mock("@calcom/features/di/containers/DestinationCalendar", () => ({
  getDestinationCalendarRepository: () => ({
    getCustomReminderByCredentialId: async () => null,
  }),
}));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url: "/api/integrations/googlevideo/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildCredential = (
  overrides: Partial<CredentialForCalendarServiceWithEmail> = {}
): CredentialForCalendarServiceWithEmail => ({
  id: 1,
  type: "google_video",
  appId: "google-meet",
  userId: 7,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  delegatedTo: null,
  user: { email: "host@example.com" },
  key: {
    access_token: "valid-access-token",
    refresh_token: "valid-refresh-token",
    expiry_date: Date.now() + 3_600_000,
    token_type: "Bearer",
  },
  ...overrides,
});

const buildMeetingEvent = (): CalendarServiceEvent => {
  // EventManager builds this request id from the Meet location; the adapter only forwards it.
  const conferenceData = { createRequest: { requestId: "meet-request-id" } };
  return {
    type: "booking",
    title: "Product sync",
    startTime: "2024-06-15T10:00:00Z",
    endTime: "2024-06-15T11:00:00Z",
    organizer: {
      id: 1,
      name: "Host",
      email: "host@example.com",
      timeZone: "UTC",
      language: { translate: ((key: string) => key) as never, locale: "en" },
    },
    attendees: [
      {
        id: 2,
        name: "Guest",
        email: "guest@example.com",
        timeZone: "UTC",
        language: { translate: ((key: string) => key) as never, locale: "en" },
      },
    ],
    location: MeetLocationType,
    calendarDescription: "Product sync description",
    destinationCalendar: [{ externalId: "primary", credentialId: 1, integration: "google_calendar" }],
    iCalUID: "ical-uid@google.com",
    conferenceData,
  } as unknown as CalendarServiceEvent;
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.resetMocks();
  getGoogleAppKeysMock.mockResolvedValue({
    client_id: "google-client-id",
    client_secret: "google-client-secret",
    redirect_uris: ["http://localhost:3000/api/integrations/googlecalendar/callback"],
  });
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 9 });
});

describe("Google Meet app registration", () => {
  it("declares the Google Calendar dependency and the Meet location", () => {
    expect(metadata).toMatchObject({
      slug: "google-meet",
      type: "google_video",
      dirName: "googlevideo",
      isOAuth: false,
      dependencies: ["google-calendar"],
      appData: {
        location: {
          linkType: "dynamic",
          type: MeetLocationType,
          label: "Google Meet",
        },
      },
    });
  });

  it("installs a google_video credential without creating a meeting API credential", async () => {
    const res = createResponse();

    await installGoogleMeet(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { type: "google_video", userId: 1 },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: {
        type: "google_video",
        key: {},
        userId: 1,
        appId: "google-meet",
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      url: "/apps/installed/conferencing?hl=google-meet",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a second Google Meet install", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 9 });
    const res = createResponse();

    await installGoogleMeet(buildRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Already installed" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("requires a logged-in user", async () => {
    const res = createResponse();

    await installGoogleMeet(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
    expect(prisma.credential.findFirst).not.toHaveBeenCalled();
  });

  it("has no standalone video adapter because the Meet link comes from the calendar event", async () => {
    const adapters = await getVideoAdapters([buildCredential()]);

    expect(adapters).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Google Meet link through Google Calendar", () => {
  it("forwards conferenceData and returns the provider hangoutLink as the Meet URL", async () => {
    const hangoutLink = "https://meet.google.com/abc-defg-hij";
    fetchMock.mockResponseOnce(
      JSON.stringify({ id: "evt-123", iCalUID: "ical-uid@google.com", hangoutLink }),
      { headers: { "Content-Type": "application/json" } }
    );
    fetchMock.mockResponseOnce(JSON.stringify({ id: "evt-123", hangoutLink }), {
      headers: { "Content-Type": "application/json" },
    });
    const event = buildMeetingEvent();

    const result = await BuildCalendarService(buildCredential()).createEvent(event, 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [insertUrl, insertOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    const insert = new URL(insertUrl);
    expect(decodeURIComponent(insert.pathname)).toBe("/calendar/v3/calendars/primary/events");
    expect(insert.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(insert.searchParams.get("sendUpdates")).toBe("none");
    expect(insertOptions).toMatchObject({ method: "POST" });
    const insertBody = JSON.parse(insertOptions.body as string) as Record<string, unknown>;
    expect(insertBody.conferenceData).toEqual(event.conferenceData);
    expect(insertBody.location).toBe("Google");

    const [patchUrl, patchOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const patch = new URL(patchUrl);
    expect(decodeURIComponent(patch.pathname)).toBe("/calendar/v3/calendars/primary/events/evt-123");
    expect(patchOptions).toMatchObject({ method: "PATCH" });
    const patchBody = JSON.parse(patchOptions.body as string) as Record<string, string>;
    expect(patchBody.location).toBe(hangoutLink);
    expect(patchBody.description).toContain(hangoutLink);

    expect(result).toMatchObject({
      id: "evt-123",
      type: "google_calendar",
      additionalInfo: { hangoutLink },
    });
  });

  it("does not send conferenceData for a non-Meet location", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ id: "evt-123", iCalUID: "ical-uid@google.com" }), {
      headers: { "Content-Type": "application/json" },
    });
    const event = buildMeetingEvent();
    event.location = "Test Location";

    await BuildCalendarService(buildCredential()).createEvent(event, 1);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.conferenceData).toBeUndefined();
    expect(body.location).toBe("Test Location");
  });
});
