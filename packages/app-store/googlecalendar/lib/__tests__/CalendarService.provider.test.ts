// @vitest-environment jsdom
import "vitest-fetch-mock";
import type { CalendarServiceEvent } from "@calcom/types/Calendar";
import type { CredentialForCalendarServiceWithEmail } from "@calcom/types/Credential";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { oAuthManagerHelper } from "../../../_utils/oauth/oAuthManagerHelper";
import BuildCalendarService from "../CalendarService";

vi.mock("../getGoogleAppKeys", () => ({
  getGoogleAppKeys: vi.fn().mockResolvedValue({
    client_id: "gcal-client-id",
    client_secret: "gcal-client-secret",
    redirect_uris: ["http://localhost:3000/api/integrations/googlecalendar/callback"],
  }),
}));

vi.mock("@calcom/features/di/containers/DestinationCalendar", () => ({
  getDestinationCalendarRepository: () => ({
    getCustomReminderByCredentialId: async () => null,
  }),
}));

vi.mock("../../../_utils/invalidateCredential", () => ({ invalidateCredential: vi.fn() }));

const updateTokenObjectSpy = vi
  .spyOn(oAuthManagerHelper, "updateTokenObjectInDb")
  .mockResolvedValue(undefined);

const credential = (
  accessToken: string,
  refreshToken: string,
  expiryDate: number
): CredentialForCalendarServiceWithEmail => ({
  id: 1,
  userId: 7,
  appId: "google-calendar",
  type: "google_calendar",
  key: {
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
    token_type: "Bearer",
  },
  user: { email: "host@example.com" },
  delegatedTo: null,
  delegationCredentialId: null,
  invalid: false,
  teamId: null,
  encryptedKey: null,
});

const validCredential = () => credential("valid-access-token", "valid-refresh-token", Date.now() + 3_600_000);
const expiredCredential = () =>
  credential("expired-access-token", "persisted-refresh-token", Date.now() - 60_000);

const bookingEvent = {
  type: "booking",
  title: "Product sync",
  startTime: "2024-06-15T10:00:00Z",
  endTime: "2024-06-15T11:00:00Z",
  organizer: { id: 1, name: "Host", email: "host@example.com", timeZone: "UTC" },
  attendees: [{ id: 2, name: "Guest", email: "guest@example.com", timeZone: "UTC" }],
  location: "Test Location",
  calendarDescription: "Product sync description",
  destinationCalendar: [{ externalId: "team@example.com", credentialId: 1, integration: "google_calendar" }],
  iCalUID: "ical-uid@google.com",
} as unknown as CalendarServiceEvent;

const jsonResponse = (body: unknown, status = 200) =>
  fetchMock.mockResponseOnce(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchCall = (index = 0) => {
  const call = fetchMock.mock.calls[index];
  const init = call[1] as RequestInit | undefined;
  return {
    url: new URL(String(call[0])),
    init,
    jsonBody: () => (init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null),
  };
};

beforeEach(() => {
  fetchMock.resetMocks();
  updateTokenObjectSpy.mockClear();
});

describe("availability freebusy", () => {
  test("maps provider busy blocks for the selected Google calendars and sends one freebusy request", async () => {
    jsonResponse({
      calendars: {
        "primary@example.com": {
          busy: [{ start: "2024-06-15T10:00:00Z", end: "2024-06-15T11:00:00Z" }],
        },
        "team@example.com": {
          busy: [{ start: "2024-06-15T13:00:00Z", end: "2024-06-15T14:00:00Z" }],
        },
      },
    });

    const result = await BuildCalendarService(validCredential()).getAvailability({
      dateFrom: "2024-06-15T00:00:00Z",
      dateTo: "2024-06-16T00:00:00Z",
      selectedCalendars: [
        { integration: "google_calendar", externalId: "primary@example.com" },
        { integration: "google_calendar", externalId: "team@example.com" },
        { integration: "office365_calendar", externalId: "other@example.com" },
      ],
      mode: "slots",
    });

    expect(result).toEqual([
      { start: "2024-06-15T10:00:00Z", end: "2024-06-15T11:00:00Z" },
      { start: "2024-06-15T13:00:00Z", end: "2024-06-15T14:00:00Z" },
    ]);
    const { url, init, jsonBody } = fetchCall();
    expect(url.pathname).toBe("/calendar/v3/freeBusy");
    expect(init?.method).toBe("POST");
    expect(jsonBody()).toEqual({
      timeMin: "2024-06-15T00:00:00Z",
      timeMax: "2024-06-16T00:00:00Z",
      items: [{ id: "primary@example.com" }, { id: "team@example.com" }],
    });
  });
});

describe("token refresh", () => {
  test("refreshes an expired token and persists the merged credential shape", async () => {
    jsonResponse({
      access_token: "refreshed-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    jsonResponse({ calendars: { "primary@example.com": { busy: [] } } });

    const before = Date.now();
    await BuildCalendarService(expiredCredential()).getAvailability({
      dateFrom: "2024-06-15T00:00:00Z",
      dateTo: "2024-06-16T00:00:00Z",
      selectedCalendars: [{ integration: "google_calendar", externalId: "primary@example.com" }],
      mode: "slots",
    });

    const tokenCall = fetchCall(0);
    expect(tokenCall.url.href).toBe("https://oauth2.googleapis.com/token");
    const tokenBody = new URLSearchParams(String(tokenCall.init?.body));
    expect(tokenBody.get("grant_type")).toBe("refresh_token");
    expect(tokenBody.get("refresh_token")).toBe("persisted-refresh-token");

    expect(updateTokenObjectSpy).toHaveBeenCalledTimes(1);
    const persisted = updateTokenObjectSpy.mock.calls[0][0];
    expect(persisted).toMatchObject({
      authStrategy: "oauth",
      credentialId: 1,
      userId: 7,
      delegatedToId: null,
      credentialType: "google_calendar",
      appId: "google-calendar",
      tokenObject: {
        access_token: "refreshed-access-token",
        refresh_token: "persisted-refresh-token",
        token_type: "Bearer",
      },
    });
    expect(persisted.tokenObject).not.toHaveProperty("expires_in");
    expect(persisted.tokenObject.expiry_date).toBeGreaterThanOrEqual(before + 3_600_000);

    const freeBusyCall = fetchCall(1);
    const headers = freeBusyCall.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer refreshed-access-token");
  });

  test("fails availability and persists no token when the provider rejects the refresh token", async () => {
    jsonResponse({ error: "invalid_grant" }, 400);

    await expect(
      BuildCalendarService(expiredCredential()).getAvailability({
        dateFrom: "2024-06-15T00:00:00Z",
        dateTo: "2024-06-16T00:00:00Z",
        selectedCalendars: [{ integration: "google_calendar", externalId: "primary@example.com" }],
        mode: "slots",
      })
    ).rejects.toThrow("invalid_grant");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateTokenObjectSpy).not.toHaveBeenCalled();
  });
});

describe("event request shape", () => {
  test("creates an event with the Google Calendar insert payload", async () => {
    jsonResponse({ id: "evt-123", iCalUID: "ical-uid@google.com", hangoutLink: "" });

    const result = await BuildCalendarService(validCredential()).createEvent(
      bookingEvent,
      1,
      "host@example.com"
    );

    const { url, init, jsonBody } = fetchCall();
    expect(decodeURIComponent(url.pathname)).toBe("/calendar/v3/calendars/host@example.com/events");
    expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(init?.method).toBe("POST");
    expect(jsonBody()).toMatchObject({
      summary: "Product sync",
      start: { dateTime: "2024-06-15T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2024-06-15T11:00:00Z", timeZone: "UTC" },
      attendees: [
        {
          id: "1",
          email: "host@example.com",
          displayName: "Host",
          responseStatus: "accepted",
          organizer: true,
        },
        { email: "guest@example.com", name: "Guest", responseStatus: "accepted" },
      ],
      reminders: { useDefault: true },
      iCalUID: "ical-uid@google.com",
      location: "Test Location",
    });
    expect(result).toMatchObject({
      id: "evt-123",
      type: "google_calendar",
      iCalUID: "ical-uid@google.com",
      additionalInfo: { hangoutLink: "" },
    });
  });

  test("updates an event with the Google Calendar update payload", async () => {
    jsonResponse({ id: "evt-123", iCalUID: "ical-uid@google.com" });

    const result = await BuildCalendarService(validCredential()).updateEvent(
      "evt-123",
      bookingEvent,
      "team@example.com"
    );

    const { url, init, jsonBody } = fetchCall();
    expect(decodeURIComponent(url.pathname)).toBe("/calendar/v3/calendars/team@example.com/events/evt-123");
    expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(url.searchParams.get("sendNotifications")).toBe("true");
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(init?.method).toBe("PUT");
    expect(jsonBody()).toMatchObject({
      summary: "Product sync",
      start: { dateTime: "2024-06-15T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2024-06-15T11:00:00Z", timeZone: "UTC" },
      attendees: [
        { id: "1", email: "team@example.com", organizer: true, responseStatus: "accepted" },
        { email: "guest@example.com", responseStatus: "accepted" },
      ],
      reminders: { useDefault: true },
    });
    expect(result).toMatchObject({ id: "evt-123", iCalUID: "ical-uid@google.com" });
  });

  test("deletes an event on the requested calendar", async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response(null, { status: 204 })));

    const result = await BuildCalendarService(validCredential()).deleteEvent(
      "evt-123",
      bookingEvent,
      "team@example.com"
    );

    expect(result).toBe("");
    const { url, init } = fetchCall();
    expect(decodeURIComponent(url.pathname)).toBe("/calendar/v3/calendars/team@example.com/events/evt-123");
    expect(url.searchParams.get("sendNotifications")).toBe("false");
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(init?.method).toBe("DELETE");
  });
});
