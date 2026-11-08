import { WEBAPP_URL, WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { PartialReference } from "@calcom/types/EventManager";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addJelly from "../jelly/api/add";
import jellyCallback from "../jelly/api/callback";
import jellyConfig from "../jelly/config.json";
import JellyVideoApiAdapter from "../jelly/lib/VideoApiAdapter";
import addLyra from "../lyra/api/add";
import lyraCallback from "../lyra/api/callback";
import lyraConfig from "../lyra/config.json";
import { LYRA_API_URL } from "../lyra/lib/constants";
import LyraVideoApiAdapter from "../lyra/lib/VideoApiAdapter";

const JELLY_CLIENT_ID = "jelly-client-id";
const JELLY_CLIENT_SECRET = "jelly-client-secret";
const JELLY_ACCESS_TOKEN = "jelly-access-token";
const JELLY_CALLBACK_URL = `${WEBAPP_URL}/api/integrations/jelly/callback`;
const LYRA_CLIENT_ID = "lyra-client-id";
const LYRA_CLIENT_SECRET = "lyra-client-secret";
const LYRA_ACCESS_TOKEN = "lyra-access-token";
const LYRA_REFRESH_TOKEN = "lyra-refresh-token";
const LYRA_CALLBACK_URL = `${WEBAPP_URL_FOR_OAUTH}/api/integrations/lyra/callback`;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    user: { findFirstOrThrow: vi.fn() },
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

const buildRequest = (url: string, overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url,
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildResponse = (body: Record<string, unknown>, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });

const buildEvent = () =>
  ({
    title: "Planning Session",
    startTime: "2024-01-15T09:00:00Z",
    attendees: [{ email: "alex@example.com" }],
  }) as unknown as CalendarEvent;

const buildJellyCredential = (): CredentialPayload =>
  ({
    id: 1,
    type: "jelly_conferencing",
    appId: "jelly",
    userId: 1,
    key: { access_token: JELLY_ACCESS_TOKEN },
  }) as unknown as CredentialPayload;

const buildLyraCredential = (): CredentialPayload =>
  ({
    id: 1,
    type: "lyra_video",
    appId: "lyra",
    userId: 1,
    key: {
      access_token: LYRA_ACCESS_TOKEN,
      refresh_token: LYRA_REFRESH_TOKEN,
      token_type: "Bearer",
      expiry_date: Date.now() + 3_600_000,
    },
  }) as unknown as CredentialPayload;

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: 1 });
  prisma.app.findUnique.mockImplementation(({ where }: { where: { slug: string } }) =>
    Promise.resolve({
      keys:
        where.slug === "jelly"
          ? { client_id: JELLY_CLIENT_ID, client_secret: JELLY_CLIENT_SECRET }
          : { client_id: LYRA_CLIENT_ID, client_secret: LYRA_CLIENT_SECRET },
    })
  );
  prisma.credential.create.mockResolvedValue({ id: 9 });
  prisma.credential.deleteMany.mockResolvedValue({ count: 1 });
  prisma.credential.update.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Jelly OAuth install", () => {
  it("starts the OAuth flow and declares a dynamic conferencing link", async () => {
    const res = createResponse();

    await addJelly(buildRequest("/api/integrations/jelly/add"), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://jellyjelly.com/login/oauth");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      app_id: JELLY_CLIENT_ID,
      redirect_uri: JELLY_CALLBACK_URL,
      scope: "write:jellies,read:user_email_phone",
      state: "",
    });
    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(JELLY_CLIENT_SECRET);
    expect(jellyConfig).toMatchObject({
      slug: "jelly",
      type: "jelly_conferencing",
      variant: "conferencing",
      categories: ["conferencing"],
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

describe("Jelly OAuth callback", () => {
  it("exchanges the code, replaces the previous credential and stores the token", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ access_token: JELLY_ACCESS_TOKEN }));
    const res = createResponse();

    await jellyCallback(
      buildRequest("/api/integrations/jelly/callback", { query: { code: "auth-code" } }),
      res as unknown as NextApiResponse
    );

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://www.jellyjelly.com/login/oauth/access_token");
    expect(tokenOptions).toMatchObject({ method: "POST" });
    expect(JSON.parse(tokenOptions.body as string)).toEqual({
      code: "auth-code",
      client_id: JELLY_CLIENT_ID,
      client_secret: JELLY_CLIENT_SECRET,
    });
    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({
      where: { type: "jelly_conferencing", userId: 1, appId: "jelly" },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: {
        type: "jelly_conferencing",
        key: { access_token: JELLY_ACCESS_TOKEN },
        userId: 1,
        appId: "jelly",
      },
    });
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/conferencing?hl=jelly");
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(
      JELLY_ACCESS_TOKEN
    );
  });

  it.each([
    ["a failed token request", { error: "invalid_client" }, 400],
    ["an error carried by a successful response", { error: "invalid_grant" }, 200],
  ])("returns %s without creating a credential", async (_label, body, status) => {
    fetchMock.mockResolvedValueOnce(buildResponse(body, status));
    const res = createResponse();

    await jellyCallback(
      buildRequest("/api/integrations/jelly/callback", { query: { code: "auth-code" } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: body.error });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session user before calling Jelly", async () => {
    const res = createResponse();

    await jellyCallback(
      buildRequest("/api/integrations/jelly/callback", {
        query: { code: "auth-code" },
        session: undefined,
      }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "No user found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Jelly video adapter", () => {
  it("creates a Jelly talk and returns its URL without exposing the token", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ talkId: "talk-1", url: "https://jelly.example/talk-1" }));
    const adapter = JellyVideoApiAdapter(buildJellyCredential());

    const result = await adapter?.createMeeting(buildEvent());

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.jellyjelly.com/api/ti/start_jelly");
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${JELLY_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(result).toEqual({
      type: "jelly_conferencing",
      id: "talk-1",
      password: "",
      url: "https://jelly.example/talk-1",
    });
    expect(JSON.stringify(result)).not.toContain(JELLY_ACCESS_TOKEN);
  });

  it("returns the stored link and keeps the baseline id source on update", async () => {
    const adapter = JellyVideoApiAdapter(buildJellyCredential());
    const bookingRef: PartialReference = {
      type: "jelly_conferencing",
      uid: "booking-uid",
      meetingId: "meeting-1",
      meetingUrl: "https://jelly.example/talk-1",
      externalCalendarId: "external-1",
    };

    await expect(adapter?.updateMeeting(bookingRef, buildEvent())).resolves.toEqual({
      type: "jelly_conferencing",
      id: "external-1",
      password: "",
      url: "https://jelly.example/talk-1",
    });
    await expect(
      adapter?.updateMeeting({ ...bookingRef, externalCalendarId: null }, buildEvent())
    ).resolves.toEqual({
      type: "jelly_conferencing",
      id: "",
      password: "",
      url: "https://jelly.example/talk-1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats delete and availability as local no-ops and propagates request failures", async () => {
    const adapter = JellyVideoApiAdapter(buildJellyCredential());

    await expect(adapter?.deleteMeeting("talk-1")).resolves.toEqual({});
    await expect(adapter?.getAvailability()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("socket hang up");
  });
});

describe("Lyra OAuth install", () => {
  it("starts the OAuth flow and declares a dynamic OAuth conferencing app", async () => {
    const res = createResponse();

    await addLyra(buildRequest("/api/integrations/lyra/add"), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${LYRA_API_URL}/oauth/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      client_id: LYRA_CLIENT_ID,
      redirect_uri: LYRA_CALLBACK_URL,
      scope: "meeting.create",
      state: "",
    });
    expect(prisma.user.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true },
    });
    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(LYRA_CLIENT_SECRET);
    expect(lyraConfig).toMatchObject({
      slug: "lyra",
      type: "lyra_video",
      variant: "conferencing",
      categories: ["conferencing"],
      isOAuth: true,
      appData: {
        location: {
          linkType: "dynamic",
          type: "integrations:lyra",
          label: "Lyra Meeting",
        },
      },
    });
  });
});

describe("Lyra OAuth callback", () => {
  it("exchanges the code, replaces the previous credential and stores an absolute expiry", async () => {
    const tokenRequestStartedAt = Date.now();
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        access_token: LYRA_ACCESS_TOKEN,
        refresh_token: LYRA_REFRESH_TOKEN,
        token_type: "Bearer",
        expires_in: 3_600,
      })
    );
    const res = createResponse();

    await lyraCallback(
      buildRequest("/api/integrations/lyra/callback", { query: { code: "auth-code" } }),
      res as unknown as NextApiResponse
    );

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(`${LYRA_API_URL}/api/oauth/token`);
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(tokenOptions.body as string)).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      client_id: LYRA_CLIENT_ID,
      client_secret: LYRA_CLIENT_SECRET,
      redirect_uri: LYRA_CALLBACK_URL,
    });
    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({
      where: { type: "lyra_video", userId: 1, appId: "lyra" },
    });

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { key: Record<string, unknown>; type: string; appId: string; userId: number };
    };
    expect(stored.data).toMatchObject({ type: "lyra_video", appId: "lyra", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: LYRA_ACCESS_TOKEN,
      refresh_token: LYRA_REFRESH_TOKEN,
      token_type: "Bearer",
    });
    expect(stored.data.key.expires_in).toBeUndefined();
    expect(stored.data.key.expiry_date).toBeGreaterThanOrEqual(tokenRequestStartedAt + 3_590_000);
    expect(stored.data.key.expiry_date).toBeLessThanOrEqual(tokenRequestStartedAt + 3_610_000);
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/conferencing?hl=lyra");
  });

  it.each([
    ["a failed token request", { error: "invalid_client" }, 400],
    ["an error carried by a successful response", { error: "invalid_grant" }, 200],
  ])("returns %s without creating a credential", async (_label, body, status) => {
    fetchMock.mockResolvedValueOnce(buildResponse(body, status));
    const res = createResponse();

    await lyraCallback(
      buildRequest("/api/integrations/lyra/callback", { query: { code: "auth-code" } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: body.error });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session user before calling Lyra", async () => {
    const res = createResponse();

    await lyraCallback(
      buildRequest("/api/integrations/lyra/callback", {
        query: { code: "auth-code" },
        session: undefined,
      }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "No user found" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Lyra video adapter", () => {
  it("creates a meeting with the Lyra payload and returns its URL and password", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        id: "meeting-1",
        url: "https://lyra.example/meeting-1",
        password: "pin-123",
      })
    );
    const adapter = LyraVideoApiAdapter(buildLyraCredential());

    const result = await adapter?.createMeeting(buildEvent());

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LYRA_API_URL}/api/v1/meeting`);
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${LYRA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(options.body as string)).toEqual({
      title: "Planning Session",
      start: "2024-01-15T09:00:00Z",
      attendees: ["alex@example.com"],
    });
    expect(result).toEqual({
      type: "lyra_video",
      id: "meeting-1",
      password: "pin-123",
      url: "https://lyra.example/meeting-1",
    });
  });

  it("returns the stored booking reference on update and no-ops delete and availability", async () => {
    const adapter = LyraVideoApiAdapter(buildLyraCredential());
    const bookingRef: PartialReference = {
      type: "lyra_video",
      uid: "booking-uid",
      meetingId: "meeting-1",
      meetingUrl: "https://lyra.example/meeting-1",
      meetingPassword: "pin",
    };

    await expect(adapter?.updateMeeting(bookingRef, buildEvent())).resolves.toEqual({
      type: "lyra_video",
      id: "meeting-1",
      password: "pin",
      url: "https://lyra.example/meeting-1",
    });
    await expect(adapter?.deleteMeeting("meeting-1")).resolves.toBeUndefined();
    await expect(adapter?.getAvailability()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps a failed Lyra API request", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const adapter = LyraVideoApiAdapter(buildLyraCredential());

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("Failed to create Lyra meeting");
  });
});
