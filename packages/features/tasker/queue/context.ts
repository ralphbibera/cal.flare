import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Message, Queue } from "@cloudflare/workers-types";

/**
 * Only the run ID crosses the Queue. Attempts, due time and payload stay on the D1 Task row, so a
 * redelivered message cannot carry stale run state.
 */
export type JobMessage = { runId: string };
export type JobQueueEnvironment = { JOBS?: Queue<JobMessage> };
export type JobBatch = { messages: readonly Message<JobMessage>[] };

const storageKey = Symbol.for("calflare.jobs.request-storage");
const shared = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<Queue<JobMessage> | undefined>;
};
// Vinext evaluates server modules separately for RSC and Pages/SSR.
const jobQueue = (shared[storageKey] ??= new AsyncLocalStorage<Queue<JobMessage> | undefined>());

export function withJobQueue<T>(env: JobQueueEnvironment, callback: () => T): T {
  return jobQueue.run(env.JOBS, callback);
}

export function hasJobQueue(): boolean {
  return jobQueue.getStore() !== undefined;
}

export function getJobQueue(): Queue<JobMessage> {
  const queue = jobQueue.getStore();
  if (!queue) throw new ErrorWithCode(ErrorCode.InternalServerError, "JOBS queue binding is required");
  return queue;
}
