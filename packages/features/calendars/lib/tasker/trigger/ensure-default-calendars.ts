import { defineQueueJob } from "@calcom/features/tasker/queue/JobQueue";
import { calendarsTaskConfig } from "./config";
import { calendarsTaskSchema } from "./schema";

export const ENSURE_DEFAULT_CALENDARS_JOB_ID = "calendars.ensure-default-calendars";

export const ensureDefaultCalendarsJob = defineQueueJob({
  id: ENSURE_DEFAULT_CALENDARS_JOB_ID,
  queue: "calendars",
  retry: calendarsTaskConfig.retry,
  schema: calendarsTaskSchema,
  run: async (payload) => {
    const { getCalendarsTaskService } = await import(
      "@calcom/features/calendars/di/tasker/CalendarsTaskService.container"
    );

    const calendarsTaskService = getCalendarsTaskService();
    await calendarsTaskService.ensureDefaultCalendars(payload);
  },
});
