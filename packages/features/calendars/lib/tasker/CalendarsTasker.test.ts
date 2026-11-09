import { nextRetryDelayMs } from "@calcom/features/tasker/queue/JobQueue";
import { QUEUES } from "@calcom/features/tasker/queue/queues";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarsSyncTasker } from "./CalendarsSyncTasker";
import { CalendarsTasker } from "./CalendarsTasker";
import type { CalendarsTaskService } from "./CalendarsTaskService";
import { CalendarsTriggerTasker } from "./CalendarsTriggerTasker";
import { calendarsTaskConfig } from "./trigger/config";
import { ensureDefaultCalendarsJob } from "./trigger/ensure-default-calendars";

const mocks = vi.hoisted(() => ({
  hasJobQueue: vi.fn(),
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
    vi.spyOn(ensureDefaultCalendarsJob, "enqueue").mockResolvedValue({ runId: "run-id-123" });
    mocks.hasJobQueue.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues default calendar setup on the calendars queue", async () => {
    const triggerTasker = new CalendarsTriggerTasker({ logger: createLogger() });

    const result = await triggerTasker.ensureDefaultCalendars(payload);

    expect(ensureDefaultCalendarsJob.enqueue).toHaveBeenCalledWith(payload);
    expect(result).toEqual({ runId: "run-id-123" });
  });

  it("reports configured only when the calendars queue binding is available", () => {
    const triggerTasker = new CalendarsTriggerTasker({ logger: createLogger() });

    expect(triggerTasker.isConfigured()).toBe(true);
    expect(mocks.hasJobQueue).toHaveBeenCalledWith("calendars");

    mocks.hasJobQueue.mockReturnValue(false);

    expect(triggerTasker.isConfigured()).toBe(false);
  });
});

describe("CalendarsTasker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(ensureDefaultCalendarsJob, "enqueue").mockResolvedValue({ runId: "run-id-123" });
    mocks.hasJobQueue.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs inline when the calendars queue binding is unavailable", async () => {
    mocks.hasJobQueue.mockReturnValue(false);
    const { tasker, calendarsTaskService } = createTaskers();

    const result = await tasker.ensureDefaultCalendars({ payload });

    expect(result).toEqual({ runId: "sync_test123456" });
    expect(calendarsTaskService.ensureDefaultCalendars).toHaveBeenCalledWith(payload);
    expect(ensureDefaultCalendarsJob.enqueue).not.toHaveBeenCalled();
  });

  it("falls back to running inline when enqueueing fails", async () => {
    vi.mocked(ensureDefaultCalendarsJob.enqueue).mockRejectedValueOnce(new Error("queue unavailable"));
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

    expect(QUEUES.calendars.maxConcurrency).toBe(10);
    expect(ensureDefaultCalendarsJob.queue).toBe("calendars");
    expect([1, 2, 3].map((attempt) => nextRetryDelayMs(calendarsTaskConfig.retry, attempt))).toEqual([
      82_200,
      164_400,
      undefined,
    ]);

    random.mockRestore();
  });
});
