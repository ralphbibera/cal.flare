import { nextRetryDelayMs } from "@calcom/features/tasker/queue/JobQueue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarsSyncTasker } from "./CalendarsSyncTasker";
import { CalendarsTasker } from "./CalendarsTasker";
import type { CalendarsTaskService } from "./CalendarsTaskService";
import { CalendarsTriggerTasker } from "./CalendarsTriggerTasker";
import { calendarsTaskConfig } from "./trigger/config";

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  hasJobQueue: vi.fn(),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("test123456"),
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return { ...actual, ENABLE_ASYNC_TASKER: true };
});

vi.mock("@calcom/features/tasker/queue/JobQueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/features/tasker/queue/JobQueue")>();
  return { ...actual, enqueueJob: mocks.enqueueJob };
});

vi.mock("@calcom/features/tasker/queue/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/features/tasker/queue/context")>();
  return { ...actual, hasJobQueue: mocks.hasJobQueue };
});

const payload = { userId: 1 };

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
  const calendarsTaskService = {
    ensureDefaultCalendars: vi.fn().mockResolvedValue(undefined),
  } as unknown as CalendarsTaskService;
  const syncTasker = new CalendarsSyncTasker({ logger, calendarsTaskService });
  const asyncTasker = new CalendarsTriggerTasker({ logger });

  return {
    calendarsTaskService,
    tasker: new CalendarsTasker({ logger, syncTasker, asyncTasker }),
  };
}

describe("CalendarsTriggerTasker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueJob.mockResolvedValue({ runId: "run-id-123" });
    mocks.hasJobQueue.mockReturnValue(true);
  });

  it("enqueues default calendar setup on the JOBS queue", async () => {
    const triggerTasker = new CalendarsTriggerTasker({ logger: createLogger() });

    const result = await triggerTasker.ensureDefaultCalendars(payload);

    expect(mocks.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "calendars.ensure-default-calendars" }),
      payload
    );
    expect(result).toEqual({ runId: "run-id-123" });
  });

  it("reports configured only when the JOBS binding is available", () => {
    const triggerTasker = new CalendarsTriggerTasker({ logger: createLogger() });

    expect(triggerTasker.isConfigured()).toBe(true);

    mocks.hasJobQueue.mockReturnValue(false);

    expect(triggerTasker.isConfigured()).toBe(false);
  });
});

describe("CalendarsTasker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueJob.mockResolvedValue({ runId: "run-id-123" });
    mocks.hasJobQueue.mockReturnValue(true);
  });

  it("runs inline when the JOBS binding is unavailable", async () => {
    mocks.hasJobQueue.mockReturnValue(false);
    const { tasker, calendarsTaskService } = createTaskers();

    const result = await tasker.ensureDefaultCalendars({ payload });

    expect(result).toEqual({ runId: "sync_test123456" });
    expect(calendarsTaskService.ensureDefaultCalendars).toHaveBeenCalledWith(payload);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it("falls back to running inline when enqueueing fails", async () => {
    mocks.enqueueJob.mockRejectedValueOnce(new Error("queue unavailable"));
    const { tasker, calendarsTaskService } = createTaskers();

    const result = await tasker.ensureDefaultCalendars({ payload });

    expect(result).toEqual({ runId: "sync_test123456" });
    expect(calendarsTaskService.ensureDefaultCalendars).toHaveBeenCalledWith(payload);
  });

  it("returns the queued run ID when the queue accepts the payload", async () => {
    const { tasker, calendarsTaskService } = createTaskers();

    const result = await tasker.ensureDefaultCalendars({ payload });

    expect(result).toEqual({ runId: "run-id-123" });
    expect(calendarsTaskService.ensureDefaultCalendars).not.toHaveBeenCalled();
  });
});

describe("calendar job retry policy", () => {
  it("retains the source concurrency and randomized 60s-300s backoff", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.37);

    expect(calendarsTaskConfig.concurrencyLimit).toBe(10);
    expect([1, 2, 3].map((attempt) => nextRetryDelayMs(calendarsTaskConfig.retry, attempt))).toEqual([
      82_200,
      164_400,
      undefined,
    ]);

    random.mockRestore();
  });
});
