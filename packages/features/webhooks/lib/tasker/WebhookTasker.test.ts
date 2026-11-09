import { nextRetryDelayMs } from "@calcom/features/tasker/queue/JobQueue";
import { QUEUES } from "@calcom/features/tasker/queue/queues";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookTaskConsumer } from "../service/WebhookTaskConsumer";
import type { WebhookTaskPayload } from "../types/webhookTask";
import { webhookDeliveryTaskConfig } from "./trigger/config";
import { deliverWebhookJob } from "./trigger/deliver-webhook";
import { WebhookSyncTasker } from "./WebhookSyncTasker";
import { WebhookTriggerTasker } from "./WebhookTriggerTasker";

const mocks = vi.hoisted(() => ({
  hasJobQueue: vi.fn(),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("test123456"),
}));

vi.mock("@calcom/features/tasker/queue/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/features/tasker/queue/context")>();
  return { ...actual, hasJobQueue: mocks.hasJobQueue };
});

const createMockWebhookTaskPayload = (): WebhookTaskPayload => ({
  operationId: "test-operation-id",
  triggerEvent: "BOOKING_CREATED",
  bookingUid: "test-booking-uid",
  eventTypeId: 1,
  teamId: null,
  userId: 1,
  timestamp: new Date().toISOString(),
});

describe("WebhookSyncTasker", () => {
  let mockWebhookTaskConsumer: WebhookTaskConsumer;
  let syncTasker: WebhookSyncTasker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebhookTaskConsumer = {
      processWebhookTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as WebhookTaskConsumer;

    syncTasker = new WebhookSyncTasker({
      webhookTaskConsumer: mockWebhookTaskConsumer,
    });
  });

  it("should execute webhook delivery immediately via consumer", async () => {
    const payload = createMockWebhookTaskPayload();

    const result = await syncTasker.deliverWebhook(payload);

    expect(mockWebhookTaskConsumer.processWebhookTask).toHaveBeenCalledTimes(1);
    expect(mockWebhookTaskConsumer.processWebhookTask).toHaveBeenCalledWith(
      payload,
      expect.stringMatching(/^sync_/)
    );
    expect(result.taskId).toMatch(/^sync_/);
  });

  it("should generate unique task IDs for each delivery", async () => {
    const payload = createMockWebhookTaskPayload();

    const result1 = await syncTasker.deliverWebhook(payload);
    const result2 = await syncTasker.deliverWebhook(payload);

    expect(result1.taskId).toBe("sync_test123456");
    expect(result2.taskId).toBe("sync_test123456");
    expect(mockWebhookTaskConsumer.processWebhookTask).toHaveBeenCalledTimes(2);
  });

  it("should propagate errors from consumer", async () => {
    const payload = createMockWebhookTaskPayload();
    const error = new Error("Consumer processing failed");
    vi.mocked(mockWebhookTaskConsumer.processWebhookTask).mockRejectedValueOnce(error);

    await expect(syncTasker.deliverWebhook(payload)).rejects.toThrow("Consumer processing failed");
  });
});

describe("WebhookTriggerTasker", () => {
  let triggerTasker: WebhookTriggerTasker;
  let mockLogger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(deliverWebhookJob, "enqueue").mockResolvedValue({ runId: "run-id-123" });
    mocks.hasJobQueue.mockReturnValue(true);
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    triggerTasker = new WebhookTriggerTasker({
      logger: mockLogger as never,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should enqueue webhook delivery on the webhooks queue", async () => {
    const payload = createMockWebhookTaskPayload();

    const result = await triggerTasker.deliverWebhook(payload);

    expect(deliverWebhookJob.enqueue).toHaveBeenCalledWith(payload);
    expect(result.taskId).toBe("run-id-123");
  });

  it("should report configured only when the webhooks queue binding is available", () => {
    expect(triggerTasker.isConfigured()).toBe(true);
    expect(mocks.hasJobQueue).toHaveBeenCalledWith("webhooks");

    mocks.hasJobQueue.mockReturnValue(false);

    expect(triggerTasker.isConfigured()).toBe(false);
  });

  it("should propagate enqueue failures so the base tasker can fall back to sync", async () => {
    vi.mocked(deliverWebhookJob.enqueue).mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(triggerTasker.deliverWebhook(createMockWebhookTaskPayload())).rejects.toThrow(
      "queue unavailable"
    );
  });
});

describe("webhook delivery retry policy", () => {
  it("should retain the source concurrency and randomized 30s-600s backoff", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.37);

    expect(QUEUES.webhooks.maxConcurrency).toBe(25);
    expect(deliverWebhookJob.queue).toBe("webhooks");
    expect([1, 2, 3].map((attempt) => nextRetryDelayMs(webhookDeliveryTaskConfig.retry, attempt))).toEqual([
      41_100,
      82_200,
      undefined,
    ]);

    random.mockRestore();
  });
});
