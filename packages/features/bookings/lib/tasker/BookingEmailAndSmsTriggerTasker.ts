import { hasJobQueue } from "@calcom/features/tasker/queue/context";
import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import type { IBookingEmailAndSmsTasker } from "./types";

export class BookingEmailAndSmsTriggerDevTasker implements IBookingEmailAndSmsTasker {
  constructor(public readonly dependencies: ITaskerDependencies) {}

  isConfigured(): boolean {
    return hasJobQueue("notifications");
  }

  async request(payload: Parameters<IBookingEmailAndSmsTasker["request"]>[0]) {
    const { requestBookingNotificationsJob } = await import("./trigger/notifications/request");
    return requestBookingNotificationsJob.enqueue(payload);
  }

  async confirm(payload: Parameters<IBookingEmailAndSmsTasker["confirm"]>[0]) {
    const { confirmBookingNotificationsJob } = await import("./trigger/notifications/confirm");
    return confirmBookingNotificationsJob.enqueue(payload);
  }

  async reschedule(payload: Parameters<IBookingEmailAndSmsTasker["reschedule"]>[0]) {
    const { rescheduleBookingNotificationsJob } = await import("./trigger/notifications/reschedule");
    return rescheduleBookingNotificationsJob.enqueue(payload);
  }

  async rrReschedule(payload: Parameters<IBookingEmailAndSmsTasker["rrReschedule"]>[0]) {
    const { rrRescheduleBookingNotificationsJob } = await import("./trigger/notifications/rr-reschedule");
    return rrRescheduleBookingNotificationsJob.enqueue(payload);
  }
}
