import type { JobRetryPolicy } from "@calcom/features/tasker/queue/JobQueue";

export type CalendarsTaskConfig = {
  retry: JobRetryPolicy;
};

export const calendarsTaskConfig: CalendarsTaskConfig = {
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 60000,
    maxTimeoutInMs: 300000,
    randomize: true,
  },
};
