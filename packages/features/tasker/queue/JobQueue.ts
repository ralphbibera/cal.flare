import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { z } from "zod";
import { getJobQueue, type JobMessage } from "./context";
import type { JobQueueName } from "./queues";

export type JobRetryPolicy = {
  maxAttempts?: number;
  factor?: number;
  minTimeoutInMs?: number;
  maxTimeoutInMs?: number;
  randomize?: boolean;
};

export type QueueJobContext = {
  runId: string;
};

export type JobDelivery = JobMessage & { attempts: number };
export type JobOutcome = { action: "ack" } | { action: "retry"; delaySeconds: number };

export type JobHandler = {
  readonly id: string;
  readonly queue: JobQueueName;
  consume(delivery: JobDelivery): Promise<JobOutcome>;
};

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

// Queues rejects a delay above 24 hours.
const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;
const retryDelaySeconds = (delayMs: number) =>
  Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(1, Math.ceil(delayMs / 1000)));

export class QueueJob<TPayload> implements JobHandler {
  readonly id: string;
  readonly queue: JobQueueName;
  private readonly schema: z.ZodType<TPayload>;
  private readonly retry: JobRetryPolicy | undefined;
  private readonly run: (payload: TPayload, context: QueueJobContext) => Promise<void>;

  constructor(definition: {
    id: string;
    queue: JobQueueName;
    schema: z.ZodType<TPayload>;
    retry?: JobRetryPolicy;
    run: (payload: TPayload, context: QueueJobContext) => Promise<void>;
  }) {
    this.id = definition.id;
    this.queue = definition.queue;
    this.schema = definition.schema;
    this.retry = definition.retry;
    this.run = definition.run;
  }

  async enqueue(payload: TPayload): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    await getJobQueue(this.queue).send({ jobId: this.id, runId, payload: this.schema.parse(payload) });
    return { runId };
  }

  async consume(delivery: JobDelivery): Promise<JobOutcome> {
    let payload: TPayload;
    try {
      payload = this.schema.parse(delivery.payload);
    } catch (error) {
      // The same bytes fail every attempt, so the run is terminal as the source's invalid payload was.
      console.error(`Dropping ${this.id} run ${delivery.runId} with an invalid payload`, error);
      return { action: "ack" };
    }

    try {
      await this.run(payload, { runId: delivery.runId });
      return { action: "ack" };
    } catch (error) {
      const delayMs = nextRetryDelayMs(this.retry, delivery.attempts);
      if (delayMs === undefined) {
        console.error(`Exhausted ${this.id} run ${delivery.runId}`, error);
        return { action: "ack" };
      }
      return { action: "retry", delaySeconds: retryDelaySeconds(delayMs) };
    }
  }
}

export function defineQueueJob<TPayload>(definition: {
  id: string;
  queue: JobQueueName;
  schema: z.ZodType<TPayload>;
  retry?: JobRetryPolicy;
  run: (payload: TPayload, context: QueueJobContext) => Promise<void>;
}): QueueJob<TPayload> {
  return new QueueJob(definition);
}

export async function runJobs(
  deliveries: readonly JobDelivery[],
  handlers: readonly JobHandler[]
): Promise<JobOutcome[]> {
  const handlersById = new Map(handlers.map((handler) => [handler.id, handler]));
  return Promise.all(
    deliveries.map(async (delivery) => {
      const handler = handlersById.get(delivery.jobId);
      if (!handler) {
        throw new ErrorWithCode(ErrorCode.InternalServerError, `No queue job handles ${delivery.jobId}`);
      }
      return handler.consume(delivery);
    })
  );
}
