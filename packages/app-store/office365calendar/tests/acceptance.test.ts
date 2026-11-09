import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "vitest-fetch-mock";

import { MSTeamsLocationType } from "@calcom/app-store/constants";
import { WEBAPP_URL, WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import { Prisma } from "@calcom/prisma/client";
import type { CalendarServiceEvent } from "@calcom/types/Calendar";
import type { CredentialForCalendarServiceWithTenantId } from "@calcom/types/Credential";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import addHandler from "../api/add";
import callbackHandler from "../api/callback";
import BuildCalendarService from "../lib/CalendarService";

const mocks = vi.hoisted(() => ({
  getAppKeysFromSlug: vi.fn(),
  getOfficeAppKeys: vi.fn(),
  credentialCreate: vi.fn(),
  credentialDelete: vi.fn(),
  selectedCalendarCreate: vi.fn(),
  renewSelectedCalendarCredentialId: vi.fn(),
  updateTokenObject: vi.fn(),
  markTokenAsExpired: vi.fn(),
  invalidateCredential: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({
  default: {
    credential: { create: mocks.credentialCreate, delete: mocks.credentialDelete },
    selectedCalendar: { create: mocks.selectedCalendarCreate },
  },
}));

vi.mock("@calcom/prisma/client", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, options: { code: string }) {
      super(message);
      this.code = options.code;
    }
  }
  return { Prisma: { PrismaClientKnownRequestError } };
});

vi.mock("../../_utils/getAppKeysFromSlug", () => ({ default: mocks.getAppKeysFromSlug }));
vi.mock("../lib/getOfficeAppKeys", () => ({ getOfficeAppKeys: mocks.getOfficeAppKeys }));
vi.mock("@calcom/lib/connectedCalendar", () => ({
  renewSelectedCalendarCredentialId: mocks.renewSelectedCalendarCredentialId,
}));
vi.mock("../../_utils/oauth/oAuthManagerHelper", () => ({
  oAuthManagerHelper: {
    credentialSyncVariables: {},
    updateTokenObject: mocks.updateTokenObject,
    markTokenAsExpired: mocks.markTokenAsExpired,
    invalidateCredential: mocks.invalidateCredential,
  },
}));
vi.mock("@calcom/features/webhooks/lib/triggerDelegationCredentialErrorWebhook", () => ({
  triggerDelegationCredentialErrorWebhook: vi.fn(),
}));

const credential = (key: Record<string, unknown> = {}) =>
  ({
    id: 1,
    userId: 1,
    appId: "office365-calendar",
    type: "office365_calendar",
    key: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expiry_date: Date.now() + 3_600_000,
      ...key,
    },
    user: { email: "user@example.com" },
    delegationCredentialId: null,
    delegatedTo: null,
    invalid: false,
    teamId: null,
    encryptedKey: null,
  }) as unknown as CredentialForCalendarServiceWithTenantId;

const createEvent = (overrides: Partial<CalendarServiceEvent> = {}) => {
  const language = { locale: "en", translate: (key: string) => key };
  return {
    type: "office365_calendar",
    title: "Team sync",
    description: "Weekly sync",
    startTime: "2024-01-10T10:00:00.000Z",
    endTime: "2024-01-10T10:30:00.000Z",
    organizer: {
      id: 1,
      name: "Organizer",
      email: "organizer@example.com",
      username: "organizer",
      timeZone: "UTC",
      language,
    },
    attendees: [{ name: "Attendee", email: "attendee@example.com", timeZone: "UTC", language }],
    location: "https://meet.example.com",
    calendarDescription: "Weekly sync",
    destinationCalendar: [
      {
        userId: 1,
        credentialId: 1,
        externalId: "calendar-id",
        integration: "office365_calendar",
        primary: true,
      },
    ],
    ...overrides,
  } as CalendarServiceEvent;
};

const createResponse = () => {
  const res = { status: vi.fn(), json: vi.fn(), redirect: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const encodedState = (returnTo: string) =>
  encodeOAuthState({
    query: { state: JSON.stringify({ returnTo }) },
    session: { user: { id: 1 } },
  } as unknown as NextApiRequest);

const mockSuccessfulConnect = () => {
  fetchMock.mockResponseOnce(
    JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    })
  );
  fetchMock.mockResponseOnce(JSON.stringify({ mail: null, userPrincipalName: "user@example.com" }));
  fetchMock.mockResponseOnce(
    JSON.stringify({
      value: [
        { id: "default-calendar", isDefaultCalendar: true },
        { id: "other-calendar", isDefaultCalendar: false },
      ],
    })
  );
};

const calledUrl = (index: number) => String(fetchMock.mock.calls[index][0]);
const calledBody = (index: number) => String(fetchMock.mock.calls[index][1]?.body);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  fetchMock.resetMocks();
  mocks.getAppKeysFromSlug.mockResolvedValue({ client_id: "client-id", client_secret: "client-secret" });
  mocks.getOfficeAppKeys.mockResolvedValue({ client_id: "client-id", client_secret: "client-secret" });
  mocks.credentialCreate.mockResolvedValue({ id: 42 });
  mocks.selectedCalendarCreate.mockResolvedValue({ id: 7 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("office365calendar install", () => {
  test("redirects to Microsoft with the app scopes and callback url", async () => {
    const res = createResponse();

    await addHandler(
      { method: "GET", query: {}, session: { user: { id: 1 } } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorizeUrl = new URL(url);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-id");
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "User.Read Calendars.Read Calendars.ReadWrite offline_access"
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `${WEBAPP_URL_FOR_OAUTH}/api/integrations/office365calendar/callback`
    );
    expect(authorizeUrl.searchParams.get("prompt")).toBe("select_account");
  });

  test("rejects install when the app has no client id", async () => {
    mocks.getAppKeysFromSlug.mockResolvedValueOnce({});
    const res = createResponse();

    await addHandler(
      { method: "GET", query: {}, session: { user: { id: 1 } } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Office 365 client_id missing." });
  });
});

describe("office365calendar OAuth callback", () => {
  test("exchanges the code, stores the token and selects the default calendar", async () => {
    const res = createResponse();
    const returnTo = `${WEBAPP_URL}/apps/installed`;
    mockSuccessfulConnect();

    await callbackHandler(
      {
        query: { code: "auth-code", state: encodedState(returnTo) },
        session: { user: { id: 1 } },
      } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(calledUrl(0)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(Object.fromEntries(new URLSearchParams(calledBody(0)))).toMatchObject({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: `${WEBAPP_URL_FOR_OAUTH}/api/integrations/office365calendar/callback`,
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer access-token" });

    const credentialWrite = mocks.credentialCreate.mock.calls[0][0] as {
      data: { type: string; appId: string; userId: number; key: Record<string, unknown> };
    };
    expect(credentialWrite.data).toMatchObject({
      type: "office365_calendar",
      appId: "office365-calendar",
      userId: 1,
    });
    const { key } = credentialWrite.data;
    expect(key).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      email: "user@example.com",
    });
    expect(key).not.toHaveProperty("expires_in");
    expect(key.expiry_date).toBeCloseTo(Date.now() / 1000 + 3600, -2);

    expect(mocks.selectedCalendarCreate).toHaveBeenCalledWith({
      data: {
        userId: 1,
        integration: "office365_calendar",
        externalId: "default-calendar",
        credentialId: 42,
      },
    });
    expect(res.redirect).toHaveBeenCalledWith(returnTo);
  });

  test("rejects a callback without an authorization code", async () => {
    const res = createResponse();

    await callbackHandler(
      { query: {}, session: { user: { id: 1 } } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "No code returned" });
  });

  test("rejects a callback when the app has no client secret", async () => {
    mocks.getAppKeysFromSlug.mockResolvedValueOnce({ client_id: "client-id" });
    const res = createResponse();

    await callbackHandler(
      { query: { code: "auth-code" }, session: { user: { id: 1 } } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Office 365 client_secret missing." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("maps a rejected token exchange to the installed apps error redirect", async () => {
    const res = createResponse();
    const tokenError = { error: "invalid_grant", error_description: "AADSTS70000" };
    fetchMock.mockResponseOnce(JSON.stringify(tokenError), { status: 400 });

    await callbackHandler(
      { query: { code: "auth-code" }, session: { user: { id: 1 } } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(res.redirect).toHaveBeenCalledWith(`/apps/installed?error=${JSON.stringify(tokenError)}`);
    expect(mocks.credentialCreate).not.toHaveBeenCalled();
  });

  test("refuses to connect when the account has no default calendar", async () => {
    const res = createResponse();
    fetchMock.mockResponseOnce(
      JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ userPrincipalName: "user@example.com" }));
    fetchMock.mockResponseOnce(JSON.stringify({ value: [{ id: "other", isDefaultCalendar: false }] }));

    await callbackHandler(
      { query: { code: "auth-code" }, session: { user: { id: 1 } } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(String(res.redirect.mock.calls[0][0])).toContain("error=no_default_calendar");
    expect(mocks.credentialCreate).not.toHaveBeenCalled();
  });

  test("removes the new credential when the selected calendar is already linked", async () => {
    const res = createResponse();
    mockSuccessfulConnect();
    mocks.selectedCalendarCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    mocks.renewSelectedCalendarCredentialId.mockResolvedValueOnce(false);

    await callbackHandler(
      { query: { code: "auth-code" }, session: { user: { id: 1 } } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse
    );

    expect(mocks.credentialDelete).toHaveBeenCalledWith({ where: { id: 42 } });
    expect(String(res.redirect.mock.calls[0][0])).toContain("error=account_already_linked");
  });
});

describe("office365calendar token refresh", () => {
  test("refreshes an expired token and persists the refreshed token object", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      })
    );
    fetchMock.mockResponseOnce(
      JSON.stringify({ value: [{ id: "calendar-id", name: "Calendar", isDefaultCalendar: true }] })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ mail: "user@example.com" }));

    const service = BuildCalendarService(
      credential({ access_token: "expired-token", expiry_date: Date.now() - 1000 })
    );
    await service.listCalendars();

    expect(calledUrl(0)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(Object.fromEntries(new URLSearchParams(calledBody(0)))).toMatchObject({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "refresh-token",
      scope: "User.Read Calendars.Read Calendars.ReadWrite",
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer new-access-token",
    });

    const updatedToken = mocks.updateTokenObject.mock.calls[0][0] as {
      tokenObject: Record<string, unknown>;
      credentialId: number;
    };
    expect(updatedToken.credentialId).toBe(1);
    expect(updatedToken.tokenObject).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
    });
    expect(updatedToken.tokenObject).not.toHaveProperty("expires_in");
    expect(updatedToken.tokenObject.expiry_date).toBeCloseTo(Date.now() + 3600 * 1000, -4);
  });

  test("uses the stored token without refreshing while it is valid", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({ value: [{ id: "calendar-id", name: "Calendar", isDefaultCalendar: true }] })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ mail: "user@example.com" }));

    const service = BuildCalendarService(credential());
    await service.listCalendars();

    expect(calledUrl(0)).toContain("/me/calendars");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer access-token" });
    expect(mocks.updateTokenObject).not.toHaveBeenCalled();
  });
});

describe("office365calendar events", () => {
  test("creates an event and maps the Graph response", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        id: "event-id",
        iCalUId: "ical-uid",
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/123" },
      })
    );

    const service = BuildCalendarService(credential());
    const result = await service.createEvent(
      createEvent({
        location: MSTeamsLocationType,
        title: "Team sync",
        hideCalendarEventDetails: true,
      }),
      1
    );

    expect(calledUrl(0)).toBe("https://graph.microsoft.com/v1.0/me/calendars/calendar-id/events");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(calledBody(0))).toMatchObject({
      subject: "Team sync",
      start: { dateTime: "2024-01-10T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2024-01-10T10:30:00", timeZone: "UTC" },
      attendees: [{ emailAddress: { address: "attendee@example.com", name: "Attendee" } }],
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      sensitivity: "private",
    });
    expect(result).toMatchObject({
      id: "event-id",
      iCalUID: "ical-uid",
      url: "https://teams.microsoft.com/l/meetup-join/123",
    });
  });

  test("updates an online meeting without dropping the existing meeting body", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        isOnlineMeeting: true,
        body: { contentType: "html", content: "<p>Existing Teams meeting</p>" },
      })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ id: "event-id", iCalUId: "ical-uid" }));

    const service = BuildCalendarService(credential());
    await service.updateEvent("event-id", createEvent({ location: MSTeamsLocationType }));

    expect(calledUrl(0)).toBe("https://graph.microsoft.com/v1.0/me/calendar/events/event-id");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(calledUrl(1)).toBe("https://graph.microsoft.com/v1.0/me/calendar/events/event-id");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(calledBody(1))).toMatchObject({
      isOnlineMeeting: true,
      body: {
        contentType: "html",
        content: expect.stringContaining("<p>Existing Teams meeting</p>"),
      },
    });
  });

  test("deletes an event with the uid as the Graph event id", async () => {
    fetchMock.mockResponseOnce(null, { status: 204 });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = BuildCalendarService(credential());
    await service.deleteEvent("event-id", createEvent());

    expect(calledUrl(0)).toBe("https://graph.microsoft.com/v1.0/me/calendar/events/event-id");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
    consoleError.mockRestore();
  });

  test("maps provider failures on create and delete to thrown errors", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResponseOnce(JSON.stringify({ error: { code: "ErrorAccessDenied" } }), {
      status: 500,
      statusText: "Internal Server Error",
    });
    fetchMock.mockResponseOnce(JSON.stringify({ error: { code: "ErrorAccessDenied" } }), {
      status: 500,
      statusText: "Internal Server Error",
    });

    const service = BuildCalendarService(credential());
    await expect(service.createEvent(createEvent(), 1)).rejects.toThrow("Internal Server Error");
    await expect(service.deleteEvent("event-id", createEvent())).rejects.toThrow("Internal Server Error");

    consoleLog.mockRestore();
    consoleError.mockRestore();
  });
});
