import { BookingActionMap } from "@calcom/features/bookings/lib/BookingEmailSmsHandler";
import { type JobDelivery, nextRetryDelayMs, runJobs } from "@calcom/features/tasker/queue/JobQueue";
import { QUEUES } from "@calcom/features/tasker/queue/queues";
import { SchedulingType } from "@calcom/prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingEmailAndSmsSyncTasker } from "./BookingEmailAndSmsSyncTasker";
import { BookingEmailAndSmsTasker } from "./BookingEmailAndSmsTasker";
import type { BookingEmailAndSmsTaskService } from "./BookingEmailAndSmsTaskService";
import { BookingEmailAndSmsTriggerDevTasker } from "./BookingEmailAndSmsTriggerTasker";
import { bookingNotificationsTaskConfig } from "./trigger/notifications/config";
import { confirmBookingNotificationsJob } from "./trigger/notifications/confirm";
import {
  REQUEST_BOOKING_NOTIFICATIONS_JOB_ID,
  requestBookingNotificationsJob,
} from "./trigger/notifications/request";
import { rescheduleBookingNotificationsJob } from "./trigger/notifications/reschedule";
import { rrRescheduleBookingNotificationsJob } from "./trigger/notifications/rr-reschedule";

const mocks = vi.hoisted(() => ({
  hasJobQueue: vi.fn(),
  bookingTaskService: {
    request: vi.fn(),
    confirm: vi.fn(),
    reschedule: vi.fn(),
    rrReschedule: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("test123456"),
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return { ...actual, ENABLE_ASYNC_TASKER: true };
});

vi.mock("@calcom/features/tasker/queue/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/features/tasker/queue/context")>();
  return { ...actual, hasJobQueue: mocks.hasJobQueue };
});

vi.mock("@calcom/features/bookings/di/tasker/BookingEmailAndSmsTaskService.container", () => ({
  getBookingEmailAndSmsTaskService: () => mocks.bookingTaskService,
}));

const payload = {
  bookingId: 42,
  platformClientId: "client-id",
  isRescheduledByBooker: true,
};

// The source schema strips isRescheduledByBooker before the task runs.
const parsedPayload = {
  bookingId: 42,
  platformClientId: "client-id",
};

const jobs = [
  { method: "request", job: requestBookingNotificationsJob },
  { method: "confirm", job: confirmBookingNotificationsJob },
  { method: "reschedule", job: rescheduleBookingNotificationsJob },
  { method: "rrReschedule", job: rrRescheduleBookingNotificationsJob },
] as const;

const createLogger = () => ({
  log: vi.fn(),
  silly: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  getSubLogger: vi.fn(),
});

function createTaskers() {
  const logger = createLogger();
  const bookingTaskService = {
    request: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    rrReschedule: vi.fn().mockResolvedValue(undefined),
  } as unknown as BookingEmailAndSmsTaskService;
  const syncTasker = new BookingEmailAndSmsSyncTasker({ logger: logger as never, bookingTaskService });
  const asyncTasker = new BookingEmailAndSmsTriggerDevTasker({ logger: logger as never });

  return {
    bookingTaskService,
    tasker: new BookingEmailAndSmsTasker({ logger: logger as never, syncTasker, asyncTasker }),
  };
}

const deliveryFor = (jobId: string): JobDelivery => ({
  jobId,
  runId: "run-id-123",
  payload,
  attempts: 1,
});

describe("BookingEmailAndSmsTriggerDevTasker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const { job } of jobs) {
      vi.spyOn(job, "enqueue").mockResolvedValue({ runId: "run-id-123" });
    }
    mocks.hasJobQueue.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues every booking notification action on the notifications queue", async () => {
    const triggerTasker = new BookingEmailAndSmsTriggerDevTasker({ logger: createLogger() as never });

    await triggerTasker.request(payload);
    await triggerTasker.confirm(payload);
    await triggerTasker.reschedule(payload);
    await triggerTasker.rrReschedule(payload);

    expect(requestBookingNotificationsJob.enqueue).toHaveBeenNthCalledWith(1, payload);
    expect(confirmBookingNotificationsJob.enqueue).toHaveBeenNthCalledWith(1, payload);
    expect(rescheduleBookingNotificationsJob.enqueue).toHaveBeenNthCalledWith(1, payload);
    expect(rrRescheduleBookingNotificationsJob.enqueue).toHaveBeenNthCalledWith(1, payload);
  });

  it("returns the queued run ID", async () => {
    const triggerTasker = new BookingEmailAndSmsTriggerDevTasker({ logger: createLogger() as never });

    await expect(triggerTasker.request(payload)).resolves.toEqual({ runId: "run-id-123" });
    expect(requestBookingNotificationsJob.enqueue).toHaveBeenCalledWith(payload);
  });

  it("reports configured only when the notifications queue binding is available", () => {
    const triggerTasker = new BookingEmailAndSmsTriggerDevTasker({ logger: createLogger() as never });

    expect(triggerTasker.isConfigured()).toBe(true);
    expect(mocks.hasJobQueue).toHaveBeenCalledWith("notifications");

    mocks.hasJobQueue.mockReturnValue(false);

    expect(triggerTasker.isConfigured()).toBe(false);
  });

  it("propagates enqueue failures so the base tasker can fall back to sync", async () => {
    vi.mocked(requestBookingNotificationsJob.enqueue).mockRejectedValueOnce(new Error("queue unavailable"));
    const triggerTasker = new BookingEmailAndSmsTriggerDevTasker({ logger: createLogger() as never });

    await expect(triggerTasker.request(payload)).rejects.toThrow("queue unavailable");
  });
});

describe("booking notification queue jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of ["request", "confirm", "reschedule", "rrReschedule"] as const) {
      mocks.bookingTaskService[method].mockResolvedValue(undefined);
    }
  });

  for (const { method, job } of jobs) {
    it(`dispatches a ${method} run to the booking task service`, async () => {
      const outcome = await runJobs([deliveryFor(job.id)], [job]);

      expect(outcome).toEqual([{ action: "ack" }]);
      expect(mocks.bookingTaskService[method]).toHaveBeenCalledWith(parsedPayload);
    });
  }

  it("acknowledges an invalid payload without running the service", async () => {
    const outcome = await runJobs(
      [{ ...deliveryFor(REQUEST_BOOKING_NOTIFICATIONS_JOB_ID), payload: { bookingId: "not-a-number" } }],
      [requestBookingNotificationsJob]
    );

    expect(outcome).toEqual([{ action: "ack" }]);
    expect(mocks.bookingTaskService.request).not.toHaveBeenCalled();
  });
});

describe("BookingEmailAndSmsTasker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const { job } of jobs) {
      vi.spyOn(job, "enqueue").mockResolvedValue({ runId: "run-id-123" });
    }
    mocks.hasJobQueue.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs inline when the notifications queue binding is unavailable", async () => {
    mocks.hasJobQueue.mockReturnValue(false);
    const { tasker, bookingTaskService } = createTaskers();

    const result = await tasker.send({
      action: BookingActionMap.confirmed,
      schedulingType: null,
      payload,
    });

    expect(result).toEqual({ runId: "sync_test123456" });
    expect(bookingTaskService.confirm).toHaveBeenCalledWith(payload);
    expect(confirmBookingNotificationsJob.enqueue).not.toHaveBeenCalled();
  });

  it("falls back to running inline when enqueueing fails", async () => {
    vi.mocked(requestBookingNotificationsJob.enqueue).mockRejectedValueOnce(new Error("queue unavailable"));
    const { tasker, bookingTaskService } = createTaskers();

    const result = await tasker.send({
      action: BookingActionMap.requested,
      schedulingType: null,
      payload,
    });

    expect(result).toEqual({ runId: "sync_test123456" });
    expect(bookingTaskService.request).toHaveBeenCalledWith(payload);
  });

  it("returns the queued run ID for a reschedule", async () => {
    const { tasker, bookingTaskService } = createTaskers();

    const result = await tasker.send({
      action: BookingActionMap.rescheduled,
      schedulingType: SchedulingType.ROUND_ROBIN,
      payload,
    });

    expect(result).toEqual({ runId: "run-id-123" });
    expect(rrRescheduleBookingNotificationsJob.enqueue).toHaveBeenCalledWith(payload);
    expect(bookingTaskService.rrReschedule).not.toHaveBeenCalled();
  });
});

describe("booking notification retry policy", () => {
  it("retains the source concurrency and randomized 500ms-30s backoff", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.37);

    expect(QUEUES.notifications.maxConcurrency).toBe(20);
    for (const { job } of jobs) {
      expect(job.queue).toBe("notifications");
    }
    expect(
      [1, 2, 3].map((attempt) => nextRetryDelayMs(bookingNotificationsTaskConfig.retry, attempt))
    ).toEqual([685, 1_233, undefined]);

    random.mockRestore();
  });
});
