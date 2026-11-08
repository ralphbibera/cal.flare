import { createHash } from "node:crypto";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import addZapier from "../api/add";
import addSubscription from "../api/subscriptions/addSubscription";
import deleteSubscription from "../api/subscriptions/deleteSubscription";
import listBookings from "../api/subscriptions/listBookings";
import listOOOEntries from "../api/subscriptions/listOOOEntries";
import me from "../api/subscriptions/me";

const API_KEY = "zapier-api-key";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    apiKey: { findFirst: vi.fn() },
    booking: { findMany: vi.fn() },
    credential: { create: vi.fn() },
    outOfOfficeEntry: { findMany: vi.fn() },
    user: { findFirst: vi.fn() },
    webhook: { create: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

const validApiKey = {
  id: "key-1",
  userId: 1,
  teamId: null,
  appId: "zapier",
};

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: { apiKey: API_KEY },
    body: {},
    headers: {},
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const hashedApiKey = createHash("sha256").update(API_KEY).digest("hex");

beforeEach(() => {
  vi.resetAllMocks();
  prisma.apiKey.findFirst.mockResolvedValue(validApiKey);
  prisma.credential.create.mockResolvedValue({ id: 1 });
  prisma.webhook.create.mockResolvedValue({ id: "webhook-1" });
  prisma.webhook.delete.mockResolvedValue({ id: "webhook-1" });
  prisma.user.findFirst.mockResolvedValue({ username: "jane" });
});

describe("Zapier install", () => {
  it("creates an empty API-key credential and redirects to the Zapier catalog", async () => {
    const handler = addZapier as unknown as {
      appType: string;
      slug: string;
      variant: string;
      supportsMultipleInstalls: boolean;
      redirect: { newTab: boolean; url: string };
      createCredential: (args: { user: { id: number }; appType: string; slug: string }) => Promise<unknown>;
    };

    expect(handler).toMatchObject({
      appType: "zapier_automation",
      slug: "zapier",
      variant: "automation",
      supportsMultipleInstalls: false,
      redirect: { newTab: true, url: "https://zapier.com/apps/calcom/integrations" },
    });

    await handler.createCredential({ user: { id: 1 }, appType: handler.appType, slug: handler.slug });

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "zapier_automation", key: {}, userId: 1, appId: "zapier" },
    });
  });
});

describe("Zapier subscription API", () => {
  it("authenticates with the hashed API key and returns the subscribed user", async () => {
    const res = createResponse();

    await me(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: {
        hashedKey: hashedApiKey,
        appId: "zapier",
        OR: [{ expiresAt: null }, { expiresAt: { gte: expect.any(Date) } }],
      },
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { username: true },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ username: "jane" });
  });

  it("rejects a missing or invalid API key without creating a subscription", async () => {
    const missingKeyResponse = createResponse();
    await me(buildRequest({ query: {} }), missingKeyResponse as unknown as NextApiResponse);
    expect(missingKeyResponse.status).toHaveBeenCalledWith(401);
    expect(missingKeyResponse.json).toHaveBeenCalledWith({ message: "No API key provided" });

    prisma.apiKey.findFirst.mockResolvedValue(null);
    const invalidKeyResponse = createResponse();
    await addSubscription(
      buildRequest({
        method: "POST",
        body: {
          subscriberUrl: "https://hooks.zapier.com/hooks/catch/1/abc",
          triggerEvent: WebhookTriggerEvents.BOOKING_CREATED,
        },
      }),
      invalidKeyResponse as unknown as NextApiResponse
    );

    expect(invalidKeyResponse.status).toHaveBeenCalledWith(401);
    expect(invalidKeyResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "API key not valid" })
    );
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("stores the subscription with the requested trigger and subscriber URL", async () => {
    const res = createResponse();

    await addSubscription(
      buildRequest({
        method: "POST",
        body: {
          subscriberUrl: "https://hooks.zapier.com/hooks/catch/1/abc",
          triggerEvent: WebhookTriggerEvents.BOOKING_CREATED,
        },
      }),
      res as unknown as NextApiResponse
    );

    expect(prisma.webhook.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        userId: 1,
        teamId: null,
        eventTriggers: [WebhookTriggerEvents.BOOKING_CREATED],
        subscriberUrl: "https://hooks.zapier.com/hooks/catch/1/abc",
        active: true,
        appId: "zapier",
      }),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id: "webhook-1" });
  });

  it("deletes a subscription scoped to the API key owner", async () => {
    const res = createResponse();

    await deleteSubscription(
      buildRequest({
        method: "DELETE",
        query: { apiKey: API_KEY, id: "webhook-1" },
      }),
      res as unknown as NextApiResponse
    );

    expect(prisma.webhook.delete).toHaveBeenCalledWith({
      where: { userId: 1, appId: "zapier", id: "webhook-1" },
    });
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.json).toHaveBeenCalledWith({ message: "Subscription is deleted." });
  });

  it("returns the latest three bookings with 201 and an empty list as 201 for Zapier", async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    const res = createResponse();

    await listBookings(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        where: { eventType: { userId: 1 } },
        orderBy: { id: "desc" },
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("wraps out-of-office entries in the Zapier OOO trigger payload", async () => {
    const oooEntry = {
      id: 7,
      uuid: "ooo-1",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      start: new Date("2024-01-02T09:00:00Z"),
      end: new Date("2024-01-02T17:00:00Z"),
      notes: "Away",
      showNotePublicly: true,
      reason: { reason: "Vacation", emoji: "🌴" },
      reasonId: 1,
      user: { id: 1, name: "Jane", email: "jane@example.com", timeZone: "UTC" },
      toUser: null,
    };
    prisma.outOfOfficeEntry.findMany.mockResolvedValue([oooEntry]);
    const res = createResponse();

    await listOOOEntries(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.outOfOfficeEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        where: { userId: 1 },
        orderBy: { id: "desc" },
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([
      {
        createdAt: oooEntry.createdAt,
        triggerEvent: WebhookTriggerEvents.OOO_CREATED,
        payload: { oooEntry },
      },
    ]);
  });
});
