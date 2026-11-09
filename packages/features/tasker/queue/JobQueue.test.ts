import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineQueueJob, type JobDelivery, nextRetryDelayMs, runJobs } from "./JobQueue";
import { QUEUES } from "./queues";

const schema = z.object({ value: z.number() });

const delivery = (overrides: Partial<JobDelivery> = {}): JobDelivery => ({
  jobId: "test.job",
  runId: "run-1",
  payload: { value: 1 },
  attempts: 1,
  ...overrides,
});

const webhookRetry = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 30_000,
  maxTimeoutInMs: 600_000,
  randomize: true,
};

describe("queue job outcomes", () => {
  it("acknowledges a successful run", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const job = defineQueueJob({ id: "test.job", queue: "webhooks", schema, run });

    await expect(runJobs([delivery()], [job])).resolves.toEqual([{ action: "ack" }]);
    expect(run).toHaveBeenCalledWith({ value: 1 }, { runId: "run-1" });
  });

  it("retries with the Trigger formula until the attempt budget is spent", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.37);
    const run = vi.fn().mockRejectedValue(new Error("provider down"));
    const job = defineQueueJob({ id: "test.job", queue: "webhooks", schema, retry: webhookRetry, run });

    await expect(runJobs([delivery({ attempts: 1 })], [job])).resolves.toEqual([
      { action: "retry", delaySeconds: 42 },
    ]);
    await expect(runJobs([delivery({ attempts: 2 })], [job])).resolves.toEqual([
      { action: "retry", delaySeconds: 83 },
    ]);
    await expect(runJobs([delivery({ attempts: 3 })], [job])).resolves.toEqual([{ action: "ack" }]);

    random.mockRestore();
  });

  it("acknowledges an invalid payload without running it", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const job = defineQueueJob({ id: "test.job", queue: "webhooks", schema, run });

    await expect(runJobs([delivery({ payload: { value: "not-a-number" } })], [job])).resolves.toEqual([
      { action: "ack" },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("caps a retry delay at the transport's 24-hour maximum", async () => {
    const run = vi.fn().mockRejectedValue(new Error("provider down"));
    const job = defineQueueJob({
      id: "test.job",
      queue: "webhooks",
      schema,
      retry: {
        maxAttempts: 5,
        factor: 1,
        minTimeoutInMs: 48 * 60 * 60 * 1000,
        maxTimeoutInMs: 48 * 60 * 60 * 1000,
        randomize: false,
      },
      run,
    });

    await expect(runJobs([delivery()], [job])).resolves.toEqual([
      { action: "retry", delaySeconds: 24 * 60 * 60 },
    ]);
  });

  it("rejects a delivery that no handler owns", async () => {
    await expect(runJobs([delivery({ jobId: "missing.job" })], [])).rejects.toThrow(
      "No queue job handles missing.job"
    );
  });
});

describe("queue configuration", () => {
  it("keeps the source concurrency limit for each job family", () => {
    expect(
      Object.fromEntries(Object.entries(QUEUES).map(([name, queue]) => [name, queue.maxConcurrency]))
    ).toEqual({ webhooks: 25, calendars: 10, notifications: 20 });
  });

  it("keeps the transport retry backstop at 10 retries, above every job's 3 attempts", () => {
    for (const queue of Object.values(QUEUES)) {
      expect(queue.maxRetries).toBe(10);
      expect(queue.maxRetries).toBeGreaterThan(3);
    }
  });

  it("computes the same delays as Trigger's retry formula", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.37);
    // min(maxTimeout, (random + 1) * minTimeout * factor ** (attempt - 1)), none once attempts are spent.
    expect([1, 2, 3].map((attempt) => nextRetryDelayMs(webhookRetry, attempt))).toEqual([
      41_100,
      82_200,
      undefined,
    ]);
    expect(nextRetryDelayMs({ maxAttempts: 10, randomize: false }, 8)).toBe(60_000);
    expect(nextRetryDelayMs(undefined, 2)).toBe(2_740);
    random.mockRestore();
  });
});
