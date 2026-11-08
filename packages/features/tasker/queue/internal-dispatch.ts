import { AsyncLocalStorage } from "node:async_hooks";
import type { JobBatch } from "./context";

const storageKey = Symbol.for("calflare.jobs.internal-dispatch");
const shared = globalThis as typeof globalThis & { [storageKey]?: AsyncLocalStorage<boolean> };
// Vinext evaluates server modules separately for RSC and Pages/SSR.
const internalDispatch = (shared[storageKey] ??= new AsyncLocalStorage<boolean>());

/** Only the Worker entry runs a dispatch in this context, so a public request cannot drive a run. */
export function isInternalJobDispatch(): boolean {
  return internalDispatch.getStore() === true;
}

type DeliveredJob = { runId: string; attempts: number };
type JobOutcome = { retry?: true; delaySeconds?: number };

/**
 * The app graph runs the job because the Worker entry must stay free of app-store and Prisma code.
 * Outcomes keep the ack, delay and retry decisions on the delivery that made them.
 */
export async function dispatchJobBatch(
  batch: JobBatch,
  fetchRoute: (request: Request) => Promise<Response>
): Promise<void> {
  await internalDispatch.run(true, async () => {
    let response: Response;
    try {
      response = await fetchRoute(
        new Request("https://calflare.internal/api/tasks/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobs: batch.messages.map(toDeliveredJob) }),
        })
      );
    } catch (error) {
      console.error("Job dispatch request failed", error);
      retryAll(batch);
      return;
    }
    if (!response.ok) {
      // No Task attempt ran to an outcome, so only the transport retries.
      retryAll(batch);
      return;
    }
    const { outcomes } = (await response.json()) as { outcomes: JobOutcome[] };
    batch.messages.forEach((message, index) => applyOutcome(message, outcomes[index]));
  });
}

const toDeliveredJob = ({ body, attempts }: JobBatch["messages"][number]): DeliveredJob => ({
  runId: body.runId,
  attempts,
});

function retryAll({ messages }: JobBatch) {
  for (const message of messages) message.retry();
}

function applyOutcome(message: JobBatch["messages"][number], outcome: JobOutcome | undefined) {
  if (outcome?.retry) {
    message.retry(outcome.delaySeconds === undefined ? undefined : { delaySeconds: outcome.delaySeconds });
    return;
  }
  message.ack();
}
