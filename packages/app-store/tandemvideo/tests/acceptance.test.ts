import { WEBAPP_URL } from "@calcom/lib/constants";
import type { NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as h from "../../tests/videoAcceptanceHelpers";
import { metadata } from "../_metadata";
import addTandem from "../api/add";
import callback from "../api/callback";
import * as tandemApp from "../index";
import TandemVideoApiAdapter from "../lib/VideoApiAdapter";

const CLIENT_ID = "tandem-client-id";
const CLIENT_SECRET = "tandem-client-secret";
const BASE_URL = "https://tandem.example.com";
const ACCESS_TOKEN = "tandem-access-token";
const REFRESH_TOKEN = "tandem-refresh-token";
const CALLBACK_URL = `${WEBAPP_URL}/api/integrations/tandemvideo/callback`;
const INSTALLED_PATH = "/apps/installed/conferencing?hl=tandem";
const ADD_URL = "/api/integrations/tandemvideo/add";
const APP_KEYS = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, base_url: BASE_URL };
const TOKEN_BODY = { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: "Bearer", expires_in: 3_600 };

const { prisma } = vi.hoisted(() => ({
  prisma: {
    user: { findFirstOrThrow: vi.fn() },
    app: { findUnique: vi.fn() },
    credential: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

const credential = (overrides: Parameters<typeof h.buildCredential>[0] = {}) =>
  h.buildCredential({
    type: "tandem_video",
    appId: "tandem",
    key: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: "Bearer", expiry_date: Date.now() + 3_600_000 },
    ...overrides,
  });

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  prisma.app.findUnique.mockResolvedValue({ keys: APP_KEYS });
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: 1 });
  prisma.credential.findMany.mockResolvedValue([]);
  prisma.credential.create.mockResolvedValue({ id: 9 });
  prisma.credential.deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Tandem OAuth install", () => {
  it("sends the user to Tandem with the configured client and callback", async () => {
    const res = h.createResponse();
    await addTandem(h.buildRequest(ADD_URL), res as unknown as NextApiResponse);

    expect(prisma.user.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 1 }, select: { id: true } });
    expect(prisma.app.findUnique).toHaveBeenCalledWith({ where: { slug: "tandem" } });
    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${BASE_URL}/oauth/approval`);
    expect(Object.fromEntries(authorize.searchParams)).toEqual({ client_id: CLIENT_ID, redirect_uri: CALLBACK_URL });
    expect(url).not.toContain(CLIENT_SECRET);
  });

  it("reports missing app keys and an unauthenticated install", async () => {
    for (const [keys, message] of [
      [{ base_url: BASE_URL }, "Tandem client_id missing."],
      [{ client_id: CLIENT_ID }, "Tandem base_url missing."],
    ] as const) {
      prisma.app.findUnique.mockResolvedValueOnce({ keys });
      const res = h.createResponse();
      await addTandem(h.buildRequest(ADD_URL), res as unknown as NextApiResponse);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message });
    }
    prisma.user.findFirstOrThrow.mockRejectedValueOnce(new Error("No user found"));
    const anonymous = h.createResponse() as unknown as NextApiResponse;
    await expect(addTandem(h.buildRequest(ADD_URL, { session: undefined }), anonymous)).rejects.toThrow("No user found");
  });
});

describe("Tandem OAuth callback", () => {
  it("exchanges the code, stores the tokens and does not echo them", async () => {
    fetchMock.mockResolvedValueOnce(h.buildResponse(TOKEN_BODY));
    const res = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/api/v1/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "auth-code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    expect(prisma.credential.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: { type: "tandem_video", userId: 1, appId: "tandem" },
    });
    expect(prisma.credential.deleteMany).not.toHaveBeenCalled();
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: {
        type: "tandem_video",
        appId: "tandem",
        userId: 1,
        key: expect.objectContaining({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expiry_date: expect.any(Number),
        }),
      },
    });
    expect(prisma.credential.create.mock.calls[0][0].data.key.expires_in).toBeUndefined();
    expect(res.redirect).toHaveBeenCalledWith(INSTALLED_PATH);
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(REFRESH_TOKEN);
  });

  it("replaces existing credentials and accepts an unsigned returnTo state", async () => {
    const returnTo = `${WEBAPP_URL}/apps/installed`;
    prisma.credential.findMany.mockResolvedValue([{ id: 5 }, { id: 6 }]);
    fetchMock.mockResolvedValueOnce(h.buildResponse(TOKEN_BODY));
    const replaced = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { code: "auth-code" } }), replaced as unknown as NextApiResponse);
    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [5, 6] }, userId: 1 } });
    expect(prisma.credential.create).toHaveBeenCalled();

    prisma.credential.findMany.mockResolvedValue([]);
    fetchMock.mockResolvedValueOnce(h.buildResponse(TOKEN_BODY));
    const stated = h.createResponse();
    await callback(
      h.buildRequest(ADD_URL, { query: { code: "auth-code", state: JSON.stringify({ returnTo }) } }),
      stated as unknown as NextApiResponse
    );
    expect(stated.redirect).toHaveBeenCalledWith(returnTo);
  });

  it("keeps the baseline callback error responses", async () => {
    const missingCode = h.createResponse();
    await callback(h.buildRequest(ADD_URL), missingCode as unknown as NextApiResponse);
    expect(missingCode.status).toHaveBeenCalledWith(401);
    expect(missingCode.json).toHaveBeenCalledWith({ message: "Missing code" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(h.buildResponse(TOKEN_BODY));
    const anonymous = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { code: "auth-code" }, session: undefined }), anonymous as unknown as NextApiResponse);
    expect(anonymous.status).toHaveBeenCalledWith(404);
    expect(anonymous.json).toHaveBeenCalledWith({ message: "No user found" });
    expect(prisma.credential.create).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(h.buildResponse({ error: "invalid_client" }, 400, "Bad Request"));
    const failed = h.createResponse();
    await callback(h.buildRequest(ADD_URL, { query: { code: "auth-code" } }), failed as unknown as NextApiResponse);
    expect(failed.status).not.toHaveBeenCalled();
    expect(failed.json).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Tandem video adapter", () => {
  it("creates a meeting with the Tandem event payload in seconds", async () => {
    fetchMock.mockResolvedValueOnce(h.buildResponse({ data: { id: "meeting-1", event_link: "https://tandem.example.com/m/1" } }));
    const adapter = TandemVideoApiAdapter(credential());
    const result = await adapter.createMeeting(h.buildEvent());

    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/api/v1/meetings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        meeting: {
          title: "Planning Session",
          starts_at: Date.parse("2024-01-15T09:00:00Z") / 1000,
          ends_at: Date.parse("2024-01-15T10:00:00Z") / 1000,
          description: "Planning session",
          conference_solution: "tandem",
          type: 3,
        },
      }),
    });
    expect(result).toEqual({ type: "tandem_video", id: "meeting-1", password: "", url: "https://tandem.example.com/m/1" });
  });

  it("updates, deletes, reports missing keys and wraps failed API responses", async () => {
    fetchMock
      .mockResolvedValueOnce(h.buildResponse({ data: { id: "meeting-3", event_link: "https://tandem.example.com/m/3" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204, statusText: "No Content" }));
    const adapter = TandemVideoApiAdapter(credential());
    const updated = await adapter.updateMeeting({ type: "tandem_video", uid: "booking-uid", meetingId: "meeting-1" }, h.buildEvent());
    await expect(adapter.deleteMeeting("meeting-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(1, `${BASE_URL}/api/v1/meetings/meeting-1`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: expect.stringContaining('"updates"'),
    });
    expect(updated).toMatchObject({ type: "tandem_video", id: "meeting-3" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${BASE_URL}/api/v1/meetings/meeting-1`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    fetchMock
      .mockResolvedValueOnce(h.buildResponse({}, 500, "Internal Server Error"))
      .mockResolvedValueOnce(h.buildResponse({}, 400, "Bad Request"));
    await expect(adapter.deleteMeeting("meeting-1")).rejects.toThrow("Internal Server Error");
    await expect(adapter.createMeeting(h.buildEvent())).rejects.toThrow("Bad Request");

    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    await expect(adapter.createMeeting(h.buildEvent())).rejects.toThrow("Tandem client_id missing.");
    await expect(adapter.getAvailability()).resolves.toEqual([]);
  });
});

describe("Tandem metadata", () => {
  it("describes a dynamic OAuth conferencing app", () => {
    expect(metadata).toMatchObject({
      name: "Tandem Video",
      slug: "tandem",
      categories: ["conferencing"],
      dirName: "tandemvideo",
      type: "tandem_video",
      variant: "conferencing",
      isOAuth: true,
      appData: { location: { linkType: "dynamic", type: "integrations:tandem", label: "Tandem Video" } },
    });
    expect(Object.keys(tandemApp).sort()).toEqual(["api", "lib", "metadata"]);
  });
});
