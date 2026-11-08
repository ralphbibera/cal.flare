import type { CalendarEvent } from "@calcom/types/Calendar";
import type { PartialReference } from "@calcom/types/EventManager";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addSylaps from "../api/add";
import config from "../config.json";
import SylapsApiAdapter from "../lib/VideoApiAdapter";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    credential: { create: vi.fn(), findFirst: vi.fn() },
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
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = { status: vi.fn(), json: vi.fn(), writableEnded: false };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url: "/api/integrations/sylapsvideo/add",
    session: { user: { id: 7 } },
    ...overrides,
  }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 5 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sylaps link install", () => {
  it("installs the link app with an empty credential and no provider call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = createResponse();

    await addSylaps(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { type: "sylaps_video", userId: 7 },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "sylaps_video", key: {}, userId: 7, appId: "sylapsvideo" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/conferencing?hl=sylapsvideo" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the requested returnTo path", async () => {
    const res = createResponse();

    await addSylaps(
      buildRequest({ query: { returnTo: "/apps/installed/video" } }),
      res as unknown as NextApiResponse
    );

    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/video" });
  });

  it("rejects a second installation with the baseline 500 response", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 5 });
    const res = createResponse();

    await addSylaps(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Already installed" });
  });

  it("rejects an unauthenticated install with 401", async () => {
    const res = createResponse();

    await addSylaps(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
  });
});

describe("Sylaps video adapter", () => {
  it("generates a Sylaps room URL without calling an API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = SylapsApiAdapter();

    const result = await adapter?.createMeeting({} as CalendarEvent);

    const meetingId = result.id as string;
    expect(meetingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result).toEqual({
      type: "sylaps_video",
      id: meetingId,
      password: "",
      url: `https://sylaps.com/r/${meetingId}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the stored booking reference on update", async () => {
    const adapter = SylapsApiAdapter();
    const bookingRef: PartialReference = {
      type: "sylaps_video",
      uid: "booking-uid",
      meetingId: "room-1",
      meetingUrl: "https://sylaps.com/r/room-1",
      meetingPassword: "pin",
    };

    const result = await adapter?.updateMeeting(bookingRef, {} as CalendarEvent);

    expect(result).toEqual({
      type: "sylaps_video",
      id: "room-1",
      password: "pin",
      url: "https://sylaps.com/r/room-1",
    });
  });

  it("treats delete and availability as local no-ops", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = SylapsApiAdapter();

    await expect(adapter?.deleteMeeting("room-1")).resolves.toBeUndefined();
    await expect(adapter?.getAvailability()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Sylaps metadata", () => {
  it("stays a dynamic conferencing link app", () => {
    expect(config).toMatchObject({
      slug: "sylapsvideo",
      type: "sylaps_video",
      variant: "conferencing",
      categories: ["conferencing"],
      isOAuth: false,
      appData: {
        location: {
          linkType: "dynamic",
          type: "integrations:sylaps_video",
          label: "Sylaps",
        },
      },
    });
  });
});
