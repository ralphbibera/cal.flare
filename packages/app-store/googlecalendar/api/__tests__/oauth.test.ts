// @vitest-environment jsdom
import { createHmac } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import "vitest-fetch-mock";
import { GOOGLE_CALENDAR_SCOPES, SCOPE_USERINFO_PROFILE } from "@calcom/lib/constants";
import { beforeEach, describe, expect, test, vi } from "vitest";
import addHandler from "../add";
import callbackHandler from "../callback";

const APP_URL = "http://app.cal.local:3000";
const STATE_SECRET = "oauth-state-secret";

const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  getPrimaryCalendar: vi.fn(),
  upsertSelectedCalendar: vi.fn(),
  createService: vi.fn(),
  updateProfilePhoto: vi.fn(),
}));

vi.mock("../../lib/getGoogleAppKeys", () => ({
  getGoogleAppKeys: vi.fn().mockResolvedValue({
    client_id: "gcal-client-id",
    client_secret: "gcal-client-secret",
    redirect_uris: ["http://localhost:3000/api/integrations/googlecalendar/callback"],
  }),
}));

vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: {
    create: mocks.createCredential,
  },
}));

vi.mock("@calcom/lib/connectedCalendar", () => ({
  renewSelectedCalendarCredentialId: vi.fn(),
}));

vi.mock("../../lib/CalendarService", () => ({
  createGoogleCalendarServiceWithGoogleType: mocks.createService,
}));

vi.mock("../../../_utils/oauth/updateProfilePhotoGoogle", () => ({
  updateProfilePhotoGoogle: mocks.updateProfilePhoto,
}));

const stateFor = (userId: number, state: Record<string, unknown>) => {
  const nonce = "test-nonce";
  return JSON.stringify({
    ...state,
    nonce,
    nonceHash: createHmac("sha256", STATE_SECRET).update(`${nonce}:${userId}`).digest("hex"),
  });
};

const createReq = (query: Record<string, string>, user?: { id: number; email?: string }) =>
  ({
    method: "GET",
    url: "/api/integrations/googlecalendar",
    query,
    session: user ? { user } : undefined,
  }) as unknown as NextApiRequest;

const createRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), redirect: vi.fn(), setHeader: vi.fn(), writableEnded: false };
  for (const fn of [res.status, res.json, res.redirect, res.setHeader]) fn.mockReturnValue(res);
  return res;
};

const redirectUrl = (res: ReturnType<typeof createRes>) => String(res.redirect.mock.calls[0][0]);

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", STATE_SECRET);
  fetchMock.resetMocks();
  mocks.createCredential.mockReset().mockResolvedValue({
    id: 42,
    userId: 7,
    appId: "google-calendar",
    type: "google_calendar",
    key: {},
  });
  mocks.getPrimaryCalendar.mockReset().mockResolvedValue({ id: "primary@example.com", timeZone: "UTC" });
  mocks.upsertSelectedCalendar.mockReset().mockResolvedValue(undefined);
  mocks.updateProfilePhoto.mockReset().mockResolvedValue(undefined);
  mocks.createService.mockReset().mockReturnValue({
    getPrimaryCalendar: mocks.getPrimaryCalendar,
    upsertSelectedCalendar: mocks.upsertSelectedCalendar,
  });
});

describe("OAuth add", () => {
  test("builds the Google consent URL and binds state to the session user", async () => {
    const query = {
      state: JSON.stringify({
        returnTo: `${APP_URL}/apps/installed`,
        onErrorReturnTo: APP_URL,
        fromApp: false,
      }),
    };
    const res = createRes();

    await addHandler(
      createReq(query, { id: 7, email: "host@example.com" }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const url = new URL(String(res.json.mock.calls[0][0].url));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("gcal-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/integrations/googlecalendar/callback"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      SCOPE_USERINFO_PROFILE,
      ...GOOGLE_CALENDAR_SCOPES,
    ]);
    const state = JSON.parse(String(url.searchParams.get("state")));
    expect(state).toMatchObject({ returnTo: `${APP_URL}/apps/installed`, fromApp: false });
    expect(state.nonceHash).toBe(createHmac("sha256", STATE_SECRET).update(`${state.nonce}:7`).digest("hex"));
    expect(url.toString()).not.toContain("client_secret");
  });
});

describe("OAuth callback", () => {
  const successToken = () =>
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "callback-access-token",
        refresh_token: "callback-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: [SCOPE_USERINFO_PROFILE, ...GOOGLE_CALENDAR_SCOPES].join(" "),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  test("exchanges the code, stores the token key, and redirects without exposing it", async () => {
    successToken();
    const state = stateFor(7, {
      returnTo: `${APP_URL}/apps/installed`,
      onErrorReturnTo: APP_URL,
      fromApp: false,
    });
    const res = createRes();

    await callbackHandler(
      createReq({ code: "auth-code", state }, { id: 7, email: "host@example.com" }),
      res as unknown as NextApiResponse
    );

    const tokenCall = fetchMock.mock.calls[0];
    expect(String(tokenCall[0])).toBe("https://oauth2.googleapis.com/token");
    expect(String((tokenCall[1] as RequestInit).body)).toContain("code=auth-code");

    expect(mocks.createCredential).toHaveBeenCalledTimes(1);
    expect(mocks.createCredential.mock.calls[0][0]).toMatchObject({
      userId: 7,
      appId: "google-calendar",
      type: "google_calendar",
      key: {
        access_token: "callback-access-token",
        refresh_token: "callback-refresh-token",
        token_type: "Bearer",
      },
    });
    expect(mocks.upsertSelectedCalendar).toHaveBeenCalledWith({
      eventTypeId: null,
      externalId: "primary@example.com",
    });
    expect(redirectUrl(res)).toBe(`${APP_URL}/apps/installed`);
    for (const secret of ["callback-access-token", "callback-refresh-token", "client_secret"]) {
      expect(redirectUrl(res)).not.toContain(secret);
    }
  });

  test("rejects a callback whose granted scopes omit a required calendar scope", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "callback-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: GOOGLE_CALENDAR_SCOPES[0],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const state = stateFor(7, {
      returnTo: `${APP_URL}/apps/installed`,
      onErrorReturnTo: APP_URL,
      fromApp: false,
    });
    const res = createRes();

    await callbackHandler(
      createReq({ code: "auth-code", state }, { id: 7, email: "host@example.com" }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toBe("You must grant all permissions to use this integration");
    expect(mocks.createCredential).not.toHaveBeenCalled();
  });

  test("redirects a denied install to the state error URL", async () => {
    const state = stateFor(7, {
      returnTo: `${APP_URL}/apps/installed`,
      onErrorReturnTo: `${APP_URL}/apps/installed?error=access_denied`,
      fromApp: false,
    });
    const res = createRes();

    await callbackHandler(createReq({ state }, { id: 7 }), res as unknown as NextApiResponse);

    expect(redirectUrl(res)).toBe(`${APP_URL}/apps/installed?error=access_denied`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.createCredential).not.toHaveBeenCalled();
  });
});
