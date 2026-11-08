import type { AppDeclarativeHandler } from "@calcom/types/AppHandler";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { PartialReference } from "@calcom/types/EventManager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addShimmer from "../api/add";
import config from "../config.json";
import ShimmerVideoApiAdapter from "../lib/VideoApiAdapter";

const API_KEY = "shimmer-api-key";
const API_ROUTE = "https://api.shimmer.example/";
const DAILY_ROOM = {
  id: "room-id",
  name: "room-name",
  api_created: true,
  privacy: "private",
  url: "https://example.daily.co/room-name",
  created_at: "2024-01-15T09:00:00.000Z",
  config: {
    enable_prejoin_ui: true,
    enable_people_ui: true,
    enable_emoji_reactions: true,
    enable_pip_ui: true,
    enable_hand_raising: true,
    enable_network_ui: true,
    enable_video_processing_ui: true,
    enable_noise_cancellation_ui: true,
    enable_advanced_chat: true,
    enable_chat: true,
    enable_knocking: true,
  },
};

const { prisma } = vi.hoisted(() => ({
  prisma: {
    app: { findUnique: vi.fn() },
    credential: { create: vi.fn() },
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

const buildEvent = (overrides: Record<string, unknown> = {}) =>
  ({
    uid: "booking-uid",
    title: "Planning Session",
    startTime: "2024-01-15T09:00:00Z",
    attendees: [],
    ...overrides,
  }) as unknown as CalendarEvent;

const buildResponse = (body: Record<string, unknown>, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });

const install = (handler: AppDeclarativeHandler) =>
  handler.createCredential({
    user: { id: 7 } as never,
    appType: handler.appType,
    slug: handler.slug,
  });

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  prisma.app.findUnique.mockResolvedValue({ keys: { api_key: API_KEY, api_route: API_ROUTE } });
  prisma.credential.create.mockResolvedValue({ id: 3 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Shimmer install", () => {
  it("declares a dynamic link app and installs an empty credential without fetching", async () => {
    expect(config).toMatchObject({
      slug: "shimmervideo",
      type: "shimmer_video",
      variant: "conferencing",
      categories: ["conferencing"],
      appData: {
        location: {
          linkType: "dynamic",
          type: "integrations:shimmer_video",
          label: "Shimmer Video",
        },
      },
    });

    await install(addShimmer);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "shimmer_video", key: {}, userId: 7, appId: "shimmervideo" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Shimmer video adapter", () => {
  it("creates a Daily room, tracks it with Shimmer and returns the Shimmer deep link", async () => {
    fetchMock
      .mockResolvedValueOnce(buildResponse(DAILY_ROOM))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const event = buildEvent();
    const adapter = ShimmerVideoApiAdapter();

    const result = await adapter?.createMeeting(event);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [dailyUrl, dailyOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(dailyUrl).toBe("https://api.daily.co/v1/rooms");
    expect(dailyOptions).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(dailyOptions.body as string)).toMatchObject({
      privacy: "private",
      properties: {
        enable_prejoin_ui: true,
        enable_screenshare: true,
        enable_chat: true,
      },
    });

    const [trackUrl, trackOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(trackUrl).toBe(`${API_ROUTE}trackDailyRoom`);
    expect(trackOptions).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(trackOptions.body as string)).toMatchObject({
      cal: { uid: "booking-uid" },
      daily: { name: "room-name" },
    });
    expect(result).toEqual({
      type: "shimmer_video",
      id: "room-name",
      password: "",
      url: "https://app.shimmer.care?videoId=room-name",
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("skips Shimmer tracking when no API route is configured", async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: { api_key: API_KEY, api_route: "" } });
    fetchMock.mockResolvedValueOnce(buildResponse(DAILY_ROOM));
    const adapter = ShimmerVideoApiAdapter();

    await expect(adapter?.createMeeting(buildEvent())).resolves.toMatchObject({ id: "room-name" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires the booking uid before creating a room", async () => {
    const adapter = ShimmerVideoApiAdapter();

    await expect(adapter?.createMeeting(buildEvent({ uid: undefined }))).rejects.toThrow(
      "We need the booking uid to create the Daily reference in DB"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates the existing Daily room and deletes it by uid", async () => {
    fetchMock
      .mockResolvedValueOnce(buildResponse({ ...DAILY_ROOM, name: "updated-room" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204, statusText: "No Content" }));
    const adapter = ShimmerVideoApiAdapter();
    const bookingRef: PartialReference = {
      type: "shimmer_video",
      uid: "booking-uid",
      meetingId: "room-name",
      meetingUrl: "https://app.shimmer.care?videoId=room-name",
      meetingPassword: "",
    };

    const updated = await adapter?.updateMeeting(bookingRef, buildEvent());

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api.daily.co/v1/rooms/booking-uid");
    expect(updated).toMatchObject({
      id: "updated-room",
      url: "https://app.shimmer.care?videoId=updated-room",
    });

    await adapter?.deleteMeeting("room-name");

    const [deleteUrl, deleteOptions] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(deleteUrl).toBe("https://api.daily.co/v1/rooms/room-name");
    expect(deleteOptions).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  });

  it("propagates a Daily API error", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ error: "invalid" }, 400, "Bad Request"));
    const adapter = ShimmerVideoApiAdapter();

    await expect(adapter?.createMeeting(buildEvent())).rejects.toThrow("Bad Request");
  });
});
