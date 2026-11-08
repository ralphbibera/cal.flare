import { hasJobQueue } from "@calcom/features/tasker/queue/context";
import { enqueueJob } from "@calcom/features/tasker/queue/JobQueue";
import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import { ensureDefaultCalendarsJob } from "./trigger/ensure-default-calendars";
import type { ICalendarsTasker } from "./types";

export class CalendarsTriggerTasker implements ICalendarsTasker {
  constructor(public readonly dependencies: ITaskerDependencies) {}

  isConfigured(): boolean {
    return hasJobQueue();
  }

  async ensureDefaultCalendars(
    payload: Parameters<ICalendarsTasker["ensureDefaultCalendars"]>[0]
  ): Promise<{ runId: string }> {
    return enqueueJob(ensureDefaultCalendarsJob, payload);
  }
}
