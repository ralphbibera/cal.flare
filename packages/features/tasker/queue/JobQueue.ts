import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Message } from "@cloudflare/workers-types";
import type { z } from "zod";
import { Task } from "../repository";
import { getJobQueue, type JobBatch, type JobMessage } from "./context";

export type JobRetryPolicy = {
  maxAttempts?: number;
  factor?: number;
  minTimeoutInMs?: number;
  maxTimeoutInMs?: number;
  randomize?: boolean;
};

export type QueueJob<TPayload> = {
  id: string;
  retry?: JobRetryPolicy;
  parse: (payload: unknown) => TPayload;
  execute: (storedPayload: string) => Promise<void>;
};

class JobPayloadError extends Error {}

// A Worker cannot hold a Queue consumer invocation longer than this, so an expired lease means the
// invocation that claimed the run is gone.
const RUN_LEASE_MS = 15 * 60 * 1000;

const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 60000,
  randomize: true,
};

/** Trigger's delay formula and defaults: returns no delay once the attempt budget is spent. */
export function nextRetryDelayMs(retry: JobRetryPolicy | undefined, attempt: number): number | undefined {
  const { maxAttempts, factor, minTimeoutInMs, maxTimeoutInMs, randomize } = {
    ...DEFAULT_RETRY_POLICY,
    ...retry,
  };
  if (attempt >= maxAttempts) return undefined;
  const jitter = randomize ? Math.random() + 1 : 1;
  return Math.round(Math.min(maxTimeoutInMs, jitter * minTimeoutInMs * factor ** (attempt - 1)));
}

export function defineQueueJob<TPayload>(definition: {
  id: string;
  schema: z.ZodType<TPayload>;
  retry?: JobRetryPolicy;
  run: (payload: TPayload) => Promise<void>;
}): QueueJob<TPayload> {
  return {
    id: definition.id,
    retry: definition.retry,
    parse: (payload) => definition.schema.parse(payload),
    execute: async (storedPayload) => {
      let payload: TPayload;
      try {
        payload = definition.schema.parse(JSON.parse(storedPayload));
      } catch (error) {
        throw new JobPayloadError(error instanceof Error ? error.message : "Invalid job payload");
      }
      await definition.run(payload);
    },
  };
}

export async function enqueueJob<TPayload>(
  job: QueueJob<TPayload>,
  payload: TPayload
): Promise<{ runId: string }> {
  const runId = await Task.create(job.id, JSON.stringify(job.parse(payload)), {
    maxAttempts: job.retry?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
  });
  try {
    await getJobQueue().send({ runId });
  } catch (error) {
    // The Tasker falls back to running inline, so a row left behind could run a second time.
    await Task.cancel(runId);
    throw error;
  }
  return { runId };
}

// Queues rejects a delay above 12 hours; a longer wait is re-delayed when the early message arrives.
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;
const secondsUntil = (time: Date, now: Date) =>
  Math.min(Math.ceil((time.getTime() - now.getTime()) / 1000), MAX_QUEUE_DELAY_SECONDS);

async function failAttempt(
  message: Message<JobMessage>,
  job: QueueJob<unknown>,
  run: { id: string; attempts: number; maxAttempts: number },
  error: unknown
) {
  const now = new Date();
  // Trigger does not retry a payload that fails its schema, since the same bytes fail again.
  const isTerminal = error instanceof JobPayloadError;
  const delayMs = isTerminal ? undefined : nextRetryDelayMs(job.retry, run.attempts + 1);
  const scheduledAt = delayMs === undefined ? undefined : new Date(now.getTime() + delayMs);
  await Task.failAttempt({
    id: run.id,
    attempts: run.attempts,
    nextAttempts: isTerminal ? run.maxAttempts : run.attempts + 1,
    lastError: error instanceof Error ? error.message : "Unknown error",
    now,
    scheduledAt,
  });
  if (scheduledAt) {
    // A fresh message keeps Task retries from spending the transport's redelivery budget. If this
    // send fails, the unacknowledged message is redelivered and waits out the same due time.
    await getJobQueue().send({ runId: run.id }, { delaySeconds: secondsUntil(scheduledAt, now) });
  }
  message.ack();
}

async function consumeMessage(message: Message<JobMessage>, jobs: Map<string, QueueJob<unknown>>) {
  const run = await Task.findById(message.body.runId);
  if (!run || run.succeededAt || run.attempts >= run.maxAttempts) {
    message.ack();
    return;
  }

  const job = jobs.get(run.type);
  if (!job) throw new ErrorWithCode(ErrorCode.InternalServerError, `No queue job handles ${run.type}`);

  const now = new Date();
  const claimed =
    run.scheduledAt <= now &&
    (await Task.claim({
      id: run.id,
      attempts: run.attempts,
      now,
      leaseUntil: new Date(now.getTime() + RUN_LEASE_MS),
    }));
  if (!claimed) {
    // Early or duplicate delivery: another invocation holds the lease or the retry is not due yet.
    message.retry({ delaySeconds: Math.max(secondsUntil(run.scheduledAt, now), 1) });
    return;
  }

  try {
    await job.execute(run.payload);
  } catch (error) {
    await failAttempt(message, job, run, error);
    return;
  }
  await Task.succeedAttempt({ id: run.id, attempts: run.attempts, now: new Date() });
  message.ack();
}

export async function consumeJobBatch(batch: JobBatch, jobs: readonly QueueJob<unknown>[]) {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  for (const message of batch.messages) {
    try {
      await consumeMessage(message, jobsById);
    } catch (error) {
      // Infrastructure failure: no Task attempt ran to an outcome, so only the transport retries.
      console.error(`Queue delivery failed for run ${message.body.runId}`, error);
      message.retry();
    }
  }
}
