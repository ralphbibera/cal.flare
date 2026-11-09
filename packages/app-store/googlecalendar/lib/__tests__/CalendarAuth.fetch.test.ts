import oAuthManagerMock, { defaultMockOAuthManager } from "../../../tests/__mocks__/OAuthManager";
import "../__mocks__/getGoogleAppKeys";
import type { CredentialForCalendarServiceWithEmail } from "@calcom/types/Credential";
import { OAuth2Client } from "googleapis-common";
import { afterEach, expect, test, vi } from "vitest";
import { CalendarAuth } from "../CalendarAuth";

const credential: CredentialForCalendarServiceWithEmail = {
  id: 1,
  userId: 1,
  appId: "google-calendar",
  type: "google_calendar",
  key: {
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
    expiry_date: Date.now() + 3600000,
  },
  user: { email: "user@example.test" },
  delegationCredentialId: null,
  delegatedTo: null,
  invalid: false,
  teamId: null,
  encryptedKey: null,
};

afterEach(() => vi.restoreAllMocks());

test("uses platform fetch for Google token exchange, refresh, Calendar and Meet requests", async () => {
  oAuthManagerMock.OAuthManager = defaultMockOAuthManager;
  const requests: { url: string; body: string; authorization: string | null }[] = [];
  const platformFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body: String(init?.body ?? ""),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "new-access-token", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.includes("/events")) {
      return Response.json({ id: "event-1", hangoutLink: "https://meet.google.com/test-meeting" });
    }
    return Response.json({ id: "primary", timeZone: "UTC" });
  });
  const calendar = await new CalendarAuth(credential).getClient();
  const auth = calendar.context._options.auth;
  expect(auth).toBeInstanceOf(OAuth2Client);
  if (!(auth instanceof OAuth2Client)) throw new Error("Expected a Google OAuth2 client");
  expect(auth.transporter.defaults.fetchImplementation).toBe(platformFetch);

  const exchange = await auth.getToken("synthetic-code");
  expect(exchange.tokens.access_token).toBe("new-access-token");
  const refresh = await auth.refreshAccessToken();
  expect(refresh.credentials.access_token).toBe("new-access-token");
  const primary = await calendar.calendars.get({ calendarId: "primary" });
  expect(primary.data).toEqual({ id: "primary", timeZone: "UTC" });
  const meeting = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    requestBody: { conferenceData: { createRequest: { requestId: "meeting-1" } } },
  });
  expect(meeting.data.hangoutLink).toBe("https://meet.google.com/test-meeting");
  expect(requests).toHaveLength(4);
  expect(new URLSearchParams(requests[0].body).get("grant_type")).toBe("authorization_code");
  expect(new URLSearchParams(requests[0].body).get("code")).toBe("synthetic-code");
  expect(new URLSearchParams(requests[1].body).get("grant_type")).toBe("refresh_token");
  expect(new URLSearchParams(requests[1].body).get("refresh_token")).toBe("synthetic-refresh-token");
  expect(requests[2].authorization).toBe("Bearer new-access-token");
  expect(new URL(requests[3].url).searchParams.get("conferenceDataVersion")).toBe("1");
  expect(JSON.parse(requests[3].body)).toEqual({
    conferenceData: { createRequest: { requestId: "meeting-1" } },
  });
});
