import { WEBAPP_URL } from "@calcom/lib/constants";
import type { NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as h from "../../tests/videoAcceptanceHelpers";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import { metadata } from "../_metadata";
import addHuddle01 from "../api/add";
import callback from "../api/callback";
import * as huddle01App from "../index";
import Huddle01VideoApiAdapter from "../lib/VideoApiAdapter";

const IDENTITY_TOKEN = "huddle-identity-token";
const API_TOKEN = "huddle-api-token";
const API = "https://platform-api.huddle01.workers.dev/api/v2/calendar";
const CALLBACK_URL = `${WEBAPP_URL}/api/integrations/huddle01video/callback`;
const INSTALLED_PATH = "/apps/installed/conferencing?hl=huddle01";
const ADD_URL = "/api/integrations/huddle01video/add";

const { prisma, getServerSession } = vi.hoisted(() => ({
  prisma: { credential: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() } },
  getServerSession: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/features/auth/lib/getServerSession", () => ({ getServerSession }));
vi.mock("@calcom/lib/logger", () => {
  const getSubLogger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), getSubLogger });
  return { default: { ...getSubLogger(), getSubLogger } };
});

const credential = (overrides: Parameters<typeof h.buildCredential>[0] = {}) =>
  h.buildCredential({ type: "huddle01_video", appId: "huddle01", key: { identityToken: IDENTITY_TOKEN }, ...overrides });

const response = () => h.createResponse() as unknown as NextApiResponse;
let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  vi.stubEnv("NEXTAUTH_SECRET", "huddle-test-secret");
  vi.stubEnv("HUDDLE01_API_TOKEN", API_TOKEN);
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  getServerSession.mockResolvedValue({ user: { id: 1 } });
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 9 });
  prisma.credential.update.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("Huddle01 third-party install", () => {
  it("sends the user to Huddle01 with the Cal.com callback and no app secret", async () => {
    const res = h.createResponse();
    await addHuddle01(h.buildRequest(ADD_URL), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://huddle01.app/thirdparty_auth");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      redirect_uri: CALLBACK_URL,
      state: "",
      appName: "Calcom",
    });
    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(url).not.toContain(API_TOKEN);

    const anonymous = h.createResponse();
    await addHuddle01(h.buildRequest(ADD_URL, { session: undefined }), anonymous as unknown as NextApiResponse);
    expect(anonymous.json).toHaveBeenCalledWith({ url: expect.stringContaining("huddle01.app/thirdparty_auth?") });
  });
});

describe("Huddle01 callback", () => {
  it("stores and updates the identity token without echoing it", async () => {
    const first = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { identityToken: IDENTITY_TOKEN } }), first as unknown as NextApiResponse);
    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { type: "huddle01_video", userId: 1, appId: "huddle01" },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "huddle01_video", key: { identityToken: IDENTITY_TOKEN }, userId: 1, appId: "huddle01" },
    });
    expect(first.redirect).toHaveBeenCalledWith(INSTALLED_PATH);
    expect(JSON.stringify([...first.json.mock.calls, ...first.redirect.mock.calls])).not.toContain(IDENTITY_TOKEN);

    prisma.credential.findFirst.mockResolvedValue({ id: 5 });
    await callback(h.buildRequest(ADD_URL, { query: { identityToken: IDENTITY_TOKEN } }), response());
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { key: { identityToken: IDENTITY_TOKEN } },
    });
    expect(prisma.credential.create).toHaveBeenCalledTimes(1);
  });

  it("honours a signed returnTo and ignores an unsigned state", async () => {
    const returnTo = `${WEBAPP_URL}/apps/installed`;
    const state = encodeOAuthState(h.buildRequest(ADD_URL, { query: { state: JSON.stringify({ returnTo }) } }));
    const signed = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { identityToken: IDENTITY_TOKEN, state } }), signed as unknown as NextApiResponse);
    expect(signed.redirect).toHaveBeenCalledWith(returnTo);

    const unsigned = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { identityToken: IDENTITY_TOKEN, state: JSON.stringify({ returnTo }) } }), unsigned as unknown as NextApiResponse);
    expect(unsigned.redirect).toHaveBeenCalledWith(INSTALLED_PATH);
  });

  it("rejects unauthenticated callbacks and missing identity tokens with 401", async () => {
    getServerSession.mockResolvedValue(null);
    const unauthorized = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { identityToken: IDENTITY_TOKEN }, session: undefined }), unauthorized as unknown as NextApiResponse);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(unauthorized.json).toHaveBeenCalledWith({ message: "Unauthorized" });
    expect(prisma.credential.findFirst).not.toHaveBeenCalled();

    getServerSession.mockResolvedValue({ user: { id: 1 } });
    const tokenless = h.createResponse();
    await callback(h.buildRequest(ADD_URL), tokenless as unknown as NextApiResponse);
    expect(tokenless.status).toHaveBeenCalledWith(401);
    expect(tokenless.json).toHaveBeenCalledWith({ message: "Something went wrong" });
  });
});

describe("Huddle01 video adapter", () => {
  it("sends the create, update and delete shapes to the calendar API", async () => {
    prisma.credential.findFirst.mockResolvedValue({ key: { identityToken: IDENTITY_TOKEN } });
    const room = { roomId: "room-2", meetingLink: "https://huddle01.app/room/room-2" };
    fetchMock
      .mockResolvedValueOnce(h.buildResponse({ roomId: "room-1", meetingLink: "https://huddle01.app/room/room-1" }))
      .mockResolvedValueOnce(h.buildResponse(room))
      .mockResolvedValueOnce(h.buildResponse(room));
    const adapter = Huddle01VideoApiAdapter(credential());
    const created = await adapter.createMeeting(h.buildEvent());
    const updated = await adapter.updateMeeting({ type: "huddle01_video", uid: "booking-uid", meetingId: "room-1" }, h.buildEvent());
    const deleted = await adapter.deleteMeeting("room-2");

    const headers = { "Content-Type": "application/json", "x-api-key": API_TOKEN, "x-identity-token": IDENTITY_TOKEN };
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${API}/createMeeting`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Planning Session", startTime: "2024-01-15T09:00:00Z", endTime: "2024-01-15T10:00:00Z" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${API}/updateMeeting`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        title: "Planning Session",
        startTime: "2024-01-15T09:00:00Z",
        endTime: "2024-01-15T10:00:00Z",
        meetingId: "booking-uid",
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${API}/deleteMeeting`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ meetingId: "room-2" }),
    });
    expect(created).toEqual({ type: "huddle01_video", id: "room-1", password: "", url: "https://huddle01.app/room/room-1" });
    expect(updated).toEqual(deleted);
    expect(updated).toEqual({ type: "huddle01_video", id: "room-2", password: "", url: "https://huddle01.app/room/room-2" });
  });

  it("keeps the baseline error mapping and empty availability", async () => {
    prisma.credential.findFirst.mockResolvedValue({ key: { identityToken: IDENTITY_TOKEN } });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const adapter = Huddle01VideoApiAdapter(credential());
    await expect(adapter.createMeeting(h.buildEvent())).rejects.toThrow("Error while creating meeting");

    vi.stubEnv("HUDDLE01_API_TOKEN", "");
    await expect(adapter.deleteMeeting("room-1")).rejects.toThrow("Huddle01 app key not found");

    const signedOut = Huddle01VideoApiAdapter(credential({ userId: null }));
    await expect(signedOut.createMeeting(h.buildEvent())).rejects.toThrow("User is not logged in");
    await expect(signedOut.updateMeeting({ type: "huddle01_video", uid: "uid" }, h.buildEvent())).rejects.toThrow(
      "User is not logged in"
    );
    await expect(signedOut.deleteMeeting("room-1")).rejects.toThrow("User is not logged in");
    await expect(signedOut.getAvailability()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    prisma.credential.findFirst.mockResolvedValue(null);
    await expect(adapter.deleteMeeting("room-1")).rejects.toThrow("Huddle01 credential not found");
  });
});

describe("Huddle01 metadata", () => {
  it("describes a dynamic conferencing app without OAuth", () => {
    expect(metadata).toMatchObject({
      name: "Huddle01",
      slug: "huddle01",
      categories: ["video", "conferencing"],
      dirName: "huddle01video",
      type: "huddle01_video",
      variant: "conferencing",
      isOAuth: false,
      appData: { location: { linkType: "dynamic", type: "integrations:huddle01_video", label: "Huddle01 Video" } },
    });
    expect(Object.keys(huddle01App).sort()).toEqual(["api", "lib", "metadata"]);
  });
});
