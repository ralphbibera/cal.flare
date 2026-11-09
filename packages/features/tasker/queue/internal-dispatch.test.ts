import { describe, expect, it, vi } from "vitest";
import type { JobBatch } from "./context";
import { dispatchJobBatch, isInternalJobDispatch } from "./internal-dispatch";
import type { JobDelivery } from "./JobQueue";

function delivery(jobId: string) {
  return {
    id: jobId,
    timestamp: new Date(),
    body: { jobId, runId: `${jobId}-run`, payload: { value: 1 } },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

const batch = (
  queue: JobBatch["queue"],
  ...jobIds: string[]
): {
  batch: JobBatch;
  messages: ReturnType<typeof delivery>[];
} => {
  const messages = jobIds.map(delivery);
  return { batch: { queue, messages }, messages };
};

describe("dispatchJobBatch", () => {
  it("applies each outcome to the delivery that produced it", async () => {
    const { batch: deliveries, messages } = batch("webhooks", "job-acked", "job-delayed");
    const fetchRoute = vi.fn(async () =>
      Response.json({
        outcomes: [{ action: "ack" }, { action: "retry", delaySeconds: 30 }],
      })
    );

    await dispatchJobBatch(deliveries, fetchRoute);

    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(messages[1].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("retries every delivery when the app cannot run the batch", async () => {
    const { batch: deliveries, messages } = batch("calendars", "run-1", "run-2");

    await dispatchJobBatch(deliveries, async () => new Response("broken", { status: 500 }));

    expect(messages[0].retry).toHaveBeenCalledOnce();
    expect(messages[1].retry).toHaveBeenCalledOnce();
    expect(messages[0].ack).not.toHaveBeenCalled();
  });

  it("retries every delivery when the dispatch request itself fails", async () => {
    const { batch: deliveries, messages } = batch("notifications", "run-1");

    await dispatchJobBatch(deliveries, async () => {
      throw new Error("router unavailable");
    });

    expect(messages[0].retry).toHaveBeenCalledOnce();
  });

  it("sends the queue and deliveries inside the internal dispatch context", async () => {
    const { batch: deliveries } = batch("webhooks", "run-1");
    let wasInternal = false;
    const expected: JobDelivery = {
      jobId: "run-1",
      runId: "run-1-run",
      payload: { value: 1 },
      attempts: 1,
    };
    const fetchRoute = vi.fn(async (request: Request) => {
      wasInternal = isInternalJobDispatch();
      expect(request.url).toBe("https://calflare.internal/api/tasks/jobs");
      expect(await request.json()).toEqual({ queue: "webhooks", jobs: [expected] });
      return Response.json({ outcomes: [{ action: "ack" }] });
    });

    await dispatchJobBatch(deliveries, fetchRoute);

    expect(wasInternal).toBe(true);
    expect(isInternalJobDispatch()).toBe(false);
  });
});
