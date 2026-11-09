import type { JobRetryPolicy } from "@calcom/features/tasker/queue/JobQueue";

export type CalendarsTaskConfig = {
  concurrencyLimit: number;
  retry: JobRetryPolicy;
};

export const calendarsTaskConfig: CalendarsTaskConfig = {
  concurrencyLimit: 10,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 60000,
    maxTimeoutInMs: 300000,
    randomize: true,
  },
};
