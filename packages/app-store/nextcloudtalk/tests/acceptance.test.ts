import process from "node:process";
import { WEBAPP_URL } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { PartialReference } from "@calcom/types/EventManager";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import addNextcloudTalk from "../api/add";
import callback from "../api/callback";
import config from "../config.json";
import NextcloudTalkVideoApiAdapter from "../lib/VideoApiAdapter";

const HOST = "https://cloud.example.com";
const CLIENT_ID = "nextcloud-client-id";
const CLIENT_SECRET = "nextcloud-client-secret";
const ACCESS_TOKEN = "nextcloud-access-token";
const REFRESH_TOKEN = "nextcloud-refresh-token";
const SECRET = "nextcloud-test-secret";
const CALLBACK_URL = `${WEBAPP_URL}/api/integrations/nextcloudtalk/callback`;
const TOKEN_BODY = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  token_type: "Bearer",
  expires_in: 3_600,
};

const { prisma } = vi.hoisted(() => ({
  prisma: {
    app: { findUnique: vi.fn() },
    credential: { create: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

vi.mock("@calcom/lib/logger", () => {
  const getSubLogger = () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    getSubLogger,
  });
  return { default: { ...getSubLogger(), getSubLogger } };
});

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    setHeader: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url: "/api/integrations/nextcloudtalk/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildResponse = (body: Record<string, unknown>, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });

const translate = ((key: string) => key) as never;

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "Consultation",
  title: "Planning Session",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  organizer: {
    name: "Jane Doe",
    email: "jane@example.com",
    timeZone: "UTC",
    language: { translate, locale: "en" },
  },
  attendees: [],
  ...overrides,
});

const buildCredential = (overrides: Partial<CredentialPayload> = {}): CredentialPayload => ({
  id: 1,
  type: "nextcloudtalk_video",
  appId: "nextcloudtalk",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: "jane@example.com" },
  key: { access_token: ACCESS_TOKEN, expiry_date: Date.now() + 3_600_000 },
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;
let originalSecret: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  originalSecret = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = SECRET;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  prisma.app.findUnique.mockResolvedValue({
    keys: {
      nextcloudTalkHost: HOST,
      nextcloudTalkClientId: CLIENT_ID,
      nextcloudTalkClientSecret: CLIENT_SECRET,
      nextcloudTalkPattern: "{Title}-with-{Organizer}",
    },
  });
  prisma.credential.create.mockResolvedValue({ id: 8 });
  prisma.credential.deleteMany.mockResolvedValue({ count: 1 });
  prisma.credential.update.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) {
    delete process.env.NEXTAUTH_SECRET;
  } else {
    process.env.NEXTAUTH_SECRET = originalSecret;
  }
});

describe("Nextcloud Talk OAuth install", () => {
  it("starts the OAuth flow with the app keys and a signed state", async () => {
    const returnTo = `${WEBAPP_URL}/apps/installed/conferencing?hl=nextcloudtalk`;
    const res = createResponse();

    await addNextcloudTalk(
      buildRequest({ query: { state: JSON.stringify({ returnTo }) } }),
      res as unknown as NextApiResponse
    );

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${HOST}/index.php/apps/oauth2/authorize`);
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: CALLBACK_URL,
    });
    const state = JSON.parse(params.state) as {
      returnTo: string;
      nonce: string;
      nonceHash: string;
    };
    expect(state.returnTo).toBe(returnTo);
    expect(state.nonce).toEqual(expect.any(String));
    expect(state.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("keeps the baseline unauthenticated payload without a 401 HTTP status", async () => {
    const res = createResponse();

    await addNextcloudTalk(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ status: 401, body: { error: "Unauthorized" } });
  });
});

describe("Nextcloud Talk OAuth callback", () => {
  it("exchanges the code, replaces the credential and stores the token response", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse(TOKEN_BODY));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(`${HOST}/index.php/apps/oauth2/api/v1/token`);
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(tokenOptions.body as string)).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: CALLBACK_URL,
    });

    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({
      where: { type: "nextcloudtalk_video", userId: 1, appId: "nextcloudtalk" },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: {
        type: "nextcloudtalk_video",
        key: TOKEN_BODY,
        userId: 1,
        appId: "nextcloudtalk",
      },
    });
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/conferencing?hl=nextcloudtalk");
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(REFRESH_TOKEN);
  });

  it("honours a signed returnTo state", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse(TOKEN_BODY));
    const returnTo = `${WEBAPP_URL}/apps/installed`;
    const state = encodeOAuthState(buildRequest({ query: { state: JSON.stringify({ returnTo }) } }));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code", state } }), res as unknown as NextApiResponse);

    expect(res.redirect).toHaveBeenCalledWith(returnTo);
  });

  it("returns the Nextcloud token error without creating a credential", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ error: "invalid_client" }, 400, "Bad Request"));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "invalid_client" });
    expect(prisma.credential.deleteMany).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("returns an error carried by a successful token response", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ error: "invalid_grant" }));
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "invalid_grant" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session user before calling Nextcloud", async () => {
    const res = createResponse();

    await callback(
      buildRequest({ query: { code: "auth-code" }, session: undefined }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "No user found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Nextcloud Talk video adapter", () => {
  it("creates a public room and returns the Talk call URL", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ocs: {
          meta: { status: "ok", statuscode: 200, message: "OK" },
          data: { token: "room-token" },
        },
      })
    );
    const adapter = NextcloudTalkVideoApiAdapter(buildCredential());

    const result = await adapter?.createMeeting(buildEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HOST}/ocs/v2.php/apps/spreed/api/v4/room`);
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      roomType: 3,
      roomName: "Planning-Session-with-Jane-Doe",
    });
    expect(result).toEqual({
      type: "nextcloudtalk_video",
      id: "room-token",
      password: "",
      url: `${HOST}/call/room-token`,
    });
  });

  it("deletes the Talk room through the OCS API", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ocs: {
          meta: { status: "ok", statuscode: 200, message: "OK" },
          data: { token: "" },
        },
      })
    );
    const adapter = NextcloudTalkVideoApiAdapter(buildCredential());

    await expect(adapter?.deleteMeeting("room-token")).resolves.toBeUndefined();

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HOST}/ocs/v2.php/apps/spreed/api/v4/room/room-token`);
    expect(options).toMatchObject({
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "OCS-APIRequest": "true",
      },
    });
  });

  it("wraps a rejected room deletion", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        ocs: {
          meta: { status: "error", statuscode: 404, message: "Room not found" },
          data: { token: "" },
        },
      })
    );
    const adapter = NextcloudTalkVideoApiAdapter(buildCredential());

    await expect(adapter?.deleteMeeting("room-token")).rejects.toThrow("Failed to delete meeting");
  });

  it("wraps an invalid room creation response", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({ ocs: { meta: { status: "ok", statuscode: 200, message: "OK" } } })
    );
    const adapter = NextcloudTalkVideoApiAdapter(buildCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("Unexpected error");
  });

  it("returns the stored booking reference on update", async () => {
    const adapter = NextcloudTalkVideoApiAdapter(buildCredential());
    const bookingRef: PartialReference = {
      type: "nextcloudtalk_video",
      uid: "booking-uid",
      meetingId: "room-token",
      meetingUrl: `${HOST}/call/room-token`,
      meetingPassword: "pin",
    };

    const result = await adapter?.updateMeeting(bookingRef, buildEvent());

    expect(result).toEqual({
      type: "nextcloudtalk_video",
      id: "room-token",
      password: "pin",
      url: `${HOST}/call/room-token`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Nextcloud Talk metadata", () => {
  it("stays a dynamic link app with the Talk type", () => {
    expect(config).toMatchObject({
      slug: "nextcloudtalk",
      type: "nextcloudtalk_video",
      variant: "conferencing",
      appData: {
        location: {
          linkType: "dynamic",
          type: "integrations:{SLUG}_conferencing",
          label: "{TITLE}",
        },
      },
    });
  });
});
