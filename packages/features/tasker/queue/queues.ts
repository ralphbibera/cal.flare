/** Source Trigger queue limits, one queue per job family so each keeps its own admission limit. */
export const QUEUES = {
  webhooks: { maxConcurrency: 25, maxRetries: 10, visibilityTimeoutMs: 15 * 60 * 1000 },
  calendars: { maxConcurrency: 10, maxRetries: 10, visibilityTimeoutMs: 15 * 60 * 1000 },
  notifications: { maxConcurrency: 20, maxRetries: 10, visibilityTimeoutMs: 15 * 60 * 1000 },
} as const;

export type JobQueueName = keyof typeof QUEUES;

export const DEAD_LETTER_QUEUE = "calflare-jobs-dlq";

export const queueName = (name: JobQueueName): string => `calflare-jobs-${name}`;

export const queueFromName = (name: string): JobQueueName | undefined =>
  (Object.keys(QUEUES) as JobQueueName[]).find((queue) => queueName(queue) === name);
