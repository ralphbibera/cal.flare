import { BookingStatus } from "@calcom/prisma/enums";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import wipe from "../api/wipe";

const { prisma, Reschedule } = vi.hoisted(() => ({
  prisma: {
    booking: { findMany: vi.fn() },
    credential: { create: vi.fn(), findFirst: vi.fn() },
  },
  Reschedule: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("../lib", () => ({ Reschedule }));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "POST",
    query: {},
    body: {},
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.resetAllMocks();
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.credential.create.mockResolvedValue({ id: 1 });
  prisma.credential.findFirst.mockResolvedValue(null);
  Reschedule.mockResolvedValue(true);
});

describe("Wipe My Cal install", () => {
  it("creates an empty credential and returns the installed app path", async () => {
    const res = createResponse();

    await add(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { type: "wipemycal_other", userId: 1 },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "wipemycal_other", key: {}, userId: 1, appId: "wipe-my-cal" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/other?hl=wipe-my-cal" });
  });

  it("keeps the baseline already-installed mapping to 500", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 1 });
    const res = createResponse();

    await add(buildRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Already installed" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated install", async () => {
    const res = createResponse();

    await add(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Wipe My Cal range", () => {
  it("reschedules every accepted or pending booking inside the range", async () => {
    prisma.booking.findMany.mockResolvedValue([
      { id: 1, uid: "booking-1" },
      { id: 2, uid: "booking-2" },
    ]);
    const res = createResponse();

    await wipe(
      buildRequest({
        body: { initialDate: "2024-01-15", endDate: "2024-01-16" },
      }),
      res as unknown as NextApiResponse
    );

    expect(prisma.booking.findMany).toHaveBeenCalledWith({
      where: {
        startTime: { gte: "2024-01-15" },
        endTime: { lte: "2024-01-16" },
        status: { in: [BookingStatus.ACCEPTED, BookingStatus.PENDING] },
        userId: 1,
      },
      select: { id: true, uid: true, status: true },
    });
    expect(Reschedule).toHaveBeenCalledTimes(2);
    expect(Reschedule).toHaveBeenNthCalledWith(1, "booking-1", "");
    expect(Reschedule).toHaveBeenNthCalledWith(2, "booking-2", "");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it("rejects an invalid range before querying bookings", async () => {
    const res = createResponse();

    await wipe(buildRequest({ body: { initialDate: "2024-01-15" } }), res as unknown as NextApiResponse);

    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects an unauthenticated range request", async () => {
    const res = createResponse();

    await wipe(
      buildRequest({ session: undefined, body: { initialDate: "2024-01-15", endDate: "2024-01-16" } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(Reschedule).not.toHaveBeenCalled();
  });
});
