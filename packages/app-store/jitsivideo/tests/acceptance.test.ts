import type { CalendarEvent } from "@calcom/types/Calendar";
import type { PartialReference } from "@calcom/types/EventManager";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metadata } from "../_metadata";
import addJitsi from "../api/add";
import JitsiVideoApiAdapter from "../lib/VideoApiAdapter";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    app: { findUnique: vi.fn() },
    credential: { findFirst: vi.fn(), create: vi.fn() },
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
    method: "POST",
    query: {},
    url: "/api/integrations/jitsivideo/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

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
  attendees: [
    {
      name: "Alex Smith",
      email: "alex@example.com",
      timeZone: "UTC",
      language: { translate, locale: "en" },
    },
  ],
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 4 });
  prisma.app.findUnique.mockResolvedValue({ keys: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Jitsi link install", () => {
  it("installs the link app with an empty credential key and no OAuth exchange", async () => {
    const res = createResponse();

    await addJitsi(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { type: "jitsi_video", userId: 1 },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "jitsi_video", key: {}, userId: 1, appId: "jitsi" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/conferencing?hl=jitsi" });
  });

  it("returns the requested returnTo path", async () => {
    const res = createResponse();

    await addJitsi(
      buildRequest({ query: { returnTo: "/apps/installed/video" } }),
      res as unknown as NextApiResponse
    );

    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/video" });
  });

  it("rejects an unauthenticated install with 401", async () => {
    const res = createResponse();

    await addJitsi(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
  });

  it("keeps the baseline already-installed mapping to 500", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 4 });
    const res = createResponse();

    await addJitsi(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Already installed" });
  });
});

describe("Jitsi meeting links", () => {
  it("generates a meet.jit.si link with a uuid when no app keys are configured", async () => {
    const adapter = JitsiVideoApiAdapter();

    const result = await adapter?.createMeeting(buildEvent());

    expect(result).toEqual({
      type: "jitsi_video",
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      password: "",
      url: expect.stringMatching(
        /^https:\/\/meet\.jit\.si\/cal\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      ),
    });
  });

  it("applies the configured host and title pattern without inventing an API", async () => {
    prisma.app.findUnique.mockResolvedValue({
      keys: {
        jitsiHost: "https://meet.example.com/rooms",
        jitsiPathPattern: "{Title}-with-{Scheduler}",
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = JitsiVideoApiAdapter();

    const result = await adapter?.createMeeting(buildEvent());
    await adapter?.deleteMeeting("unused");
    await adapter?.updateMeeting(
      { type: "jitsi_video", uid: "booking-uid", meetingId: "room", meetingUrl: "url", meetingPassword: "" },
      buildEvent()
    );
    await adapter?.getAvailability();

    expect(result).toEqual({
      type: "jitsi_video",
      id: "Planning-Session-with-Alex-Smith",
      password: "",
      url: "https://meet.example.com/rooms/Planning-Session-with-Alex-Smith",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the stored booking reference on update", async () => {
    const adapter = JitsiVideoApiAdapter();
    const bookingRef: PartialReference = {
      type: "jitsi_video",
      uid: "booking-uid",
      meetingId: "room-1",
      meetingUrl: "https://meet.jit.si/cal/room-1",
      meetingPassword: "pin",
    };

    const result = await adapter?.updateMeeting(bookingRef, buildEvent());

    expect(result).toEqual({
      type: "jitsi_video",
      id: "room-1",
      password: "pin",
      url: "https://meet.jit.si/cal/room-1",
    });
  });
});

describe("Jitsi metadata", () => {
  it("describes a dynamic link app with no OAuth and no extra adapter API", () => {
    expect(metadata).toMatchObject({
      slug: "jitsi",
      dirName: "jitsivideo",
      type: "jitsi_video",
      variant: "conferencing",
      isOAuth: false,
      appData: {
        location: {
          linkType: "dynamic",
          type: "integrations:jitsi",
          label: "Jitsi Video",
        },
      },
    });
    expect(Object.keys(JitsiVideoApiAdapter() ?? {}).sort()).toEqual([
      "createMeeting",
      "deleteMeeting",
      "getAvailability",
      "updateMeeting",
    ]);
  });
});
