import type { Message } from "@cloudflare/workers-types";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type { JobMessage } from "../queue/context";
import { dispatchJobBatch } from "../queue/internal-dispatch";
import { handler } from "./jobs";

function message(body: JobMessage): Message<JobMessage> {
  return {
    id: body.runId,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("jobs handler", () => {
  it("rejects a public dispatch", async () => {
    const response = await handler(
      new NextRequest("https://cal.test/api/tasks/jobs", {
        method: "POST",
        body: JSON.stringify({ queue: "webhooks", jobs: [] }),
      })
    );

    expect(response.status).toBe(401);
  });

  it("runs only the handlers registered for the delivered queue", async () => {
    const invalidWebhook = message({
      jobId: "webhook.deliver",
      runId: "invalid-webhook",
      payload: { operationId: "missing-trigger-event" },
    });

    await dispatchJobBatch({ queue: "webhooks", messages: [invalidWebhook] }, async (request) =>
      handler(new NextRequest(request.url, { method: "POST", body: await request.text() }))
    );
    expect(invalidWebhook.ack).toHaveBeenCalledOnce();

    const wrongQueue = message({ jobId: "webhook.deliver", runId: "wrong-queue", payload: {} });
    await dispatchJobBatch({ queue: "calendars", messages: [wrongQueue] }, async (request) =>
      handler(new NextRequest(request.url, { method: "POST", body: await request.text() }))
    );
    expect(wrongQueue.ack).not.toHaveBeenCalled();
    expect(wrongQueue.retry).toHaveBeenCalledOnce();
  });
});
