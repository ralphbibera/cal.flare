import { hasJobQueue } from "@calcom/features/tasker/queue/context";
import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import { ensureDefaultCalendarsJob } from "./trigger/ensure-default-calendars";
import type { ICalendarsTasker } from "./types";

export class CalendarsTriggerTasker implements ICalendarsTasker {
  constructor(public readonly dependencies: ITaskerDependencies) {}

  isConfigured(): boolean {
    return hasJobQueue("calendars");
  }

  async ensureDefaultCalendars(
    payload: Parameters<ICalendarsTasker["ensureDefaultCalendars"]>[0]
  ): Promise<{ runId: string }> {
    return ensureDefaultCalendarsJob.enqueue(payload);
  }
}
