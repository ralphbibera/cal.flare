import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Message, Queue } from "@cloudflare/workers-types";
import type { JobQueueName } from "./queues";

/**
 * The Queue message owns the run state. Attempts come from the transport, the payload and the run ID
 * are fixed at enqueue, so a redelivered message cannot carry stale state.
 */
export type JobMessage = { jobId: string; runId: string; payload: unknown };
export type JobQueueEnvironment = {
  JOBS_WEBHOOKS?: Queue<JobMessage>;
  JOBS_CALENDARS?: Queue<JobMessage>;
  JOBS_NOTIFICATIONS?: Queue<JobMessage>;
};
export type JobBatch = { queue: JobQueueName; messages: readonly Message<JobMessage>[] };

const BINDINGS = {
  webhooks: "JOBS_WEBHOOKS",
  calendars: "JOBS_CALENDARS",
  notifications: "JOBS_NOTIFICATIONS",
} as const satisfies Record<JobQueueName, keyof JobQueueEnvironment>;

const storageKey = Symbol.for("calflare.jobs.request-storage");
const shared = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<JobQueueEnvironment | undefined>;
};
// Vinext evaluates server modules separately for RSC and Pages/SSR.
const jobQueue = (shared[storageKey] ??= new AsyncLocalStorage<JobQueueEnvironment | undefined>());

export function withJobQueue<T>(env: JobQueueEnvironment, callback: () => T): T {
  return jobQueue.run(env, callback);
}

export function hasJobQueue(name: JobQueueName): boolean {
  return jobQueue.getStore()?.[BINDINGS[name]] !== undefined;
}

export function getJobQueue(name: JobQueueName): Queue<JobMessage> {
  const queue = jobQueue.getStore()?.[BINDINGS[name]];
  if (!queue) {
    throw new ErrorWithCode(ErrorCode.InternalServerError, `${BINDINGS[name]} queue binding is required`);
  }
  return queue;
}
