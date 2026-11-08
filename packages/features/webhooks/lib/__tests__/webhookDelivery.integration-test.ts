import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import type { EventType, User, Webhook } from "@calcom/prisma/client";
import { withD1Database } from "@calcom/prisma/d1";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebhookTaskPayload } from "../types/webhookTask";

let directory: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const inD1 = <T>(callback: () => T) => withD1Database({ DB: db }, callback);
const d1Test = (name: string, callback: () => unknown) => test(name, () => inD1(callback));
const d1BeforeAll = (callback: () => unknown, timeout?: number) => beforeAll(() => inD1(callback), timeout);
const d1AfterAll = (callback: () => unknown, timeout?: number) => afterAll(() => inD1(callback), timeout);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "calflare-webhook-delivery-"));
  const persistTo = join(directory, "state");
  await migrateD1({ persistTo });
  const { worker } = (await import("../../../../../apps/web/cloudflare.config")).default;
  mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(persistTo, "v3"),
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: { DB: worker.env.DB },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/**
 * Webhook Producer Integration Tests
 *
 * These tests verify that the WebhookTaskerProducerService correctly:
 * 1. Integrates with the DI container
 * 2. Calls WebhookTasker.deliverWebhook() with correct payloads
 *
 * Note: With the new WebhookTasker architecture:
 * - Async mode sends to trigger.dev (external service)
 * - Sync mode executes immediately via WebhookTaskConsumer
 *
 * Neither writes to the local Prisma Task table, so we mock
 * the WebhookTasker to verify the producer's behavior.
 */

// Track deliverWebhook calls
const deliveredWebhooks: WebhookTaskPayload[] = [];

// Mock the WebhookTasker module before importing the container
vi.mock("@calcom/features/webhooks/lib/tasker/WebhookTasker", () => ({
  WebhookTasker: class MockWebhookTasker {
    async deliverWebhook(payload: WebhookTaskPayload) {
      deliveredWebhooks.push(payload);
      return { taskId: `mock-task-${deliveredWebhooks.length}` };
    }
  },
}));

// Import after mocking
const { getWebhookProducer } = await import("@calcom/features/di/webhooks/containers/webhook");

describe("Webhook Producer Integration", () => {
  let testUser: User;
  let testEventType: EventType;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let testWebhook: Webhook;

  // Use unique identifiers for each test run to avoid collisions
  const testId = v4();

  d1BeforeAll(async () => {
    // Create test user
    testUser = await prisma.user.create({
      data: {
        email: `webhook-producer-test-${testId}@example.com`,
        username: `webhook-producer-test-${testId}`,
        name: "Webhook Producer Test User",
      },
    });

    // Create test event type
    testEventType = await prisma.eventType.create({
      data: {
        title: "Webhook Producer Test Event",
        slug: `webhook-producer-test-event-${testId}`,
        length: 30,
        userId: testUser.id,
      },
    });

    // Create test webhook
    testWebhook = await prisma.webhook.create({
      data: {
        id: `webhook-producer-test-${testId}`,
        userId: testUser.id,
        subscriberUrl: "https://example.com/webhook",
        eventTriggers: [WebhookTriggerEvents.BOOKING_CREATED],
        active: true,
      },
    });
  });

  beforeEach(() => {
    // Clear delivered webhooks before each test
    deliveredWebhooks.length = 0;
  });

  d1AfterAll(async () => {
    // Clean up all test data
    await prisma.webhook.deleteMany({
      where: { userId: testUser.id },
    });
    await prisma.eventType.deleteMany({
      where: { id: testEventType.id },
    });
    await prisma.user.deleteMany({
      where: { id: testUser.id },
    });
  });

  describe("BOOKING_REQUESTED", () => {
    d1Test("calls deliverWebhook with correct payload", async () => {
      const producer = getWebhookProducer();
      const bookingUid = "test-booking-uid-requested";

      await producer.queueBookingRequestedWebhook({
        bookingUid,
        eventTypeId: testEventType.id,
        userId: testUser.id,
      });

      expect(deliveredWebhooks.length).toBe(1);

      const payload = deliveredWebhooks[0];
      expect(payload.triggerEvent).toBe(WebhookTriggerEvents.BOOKING_REQUESTED);
      if (payload.triggerEvent === WebhookTriggerEvents.BOOKING_REQUESTED) {
        expect(payload.bookingUid).toBe(bookingUid);
      }
    });
  });
});
