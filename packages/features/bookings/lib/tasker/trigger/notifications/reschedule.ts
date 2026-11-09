import { defineQueueJob } from "@calcom/features/tasker/queue/JobQueue";
import { bookingNotificationsTaskConfig } from "./config";
import { bookingNotificationTaskSchema } from "./schema";

export const RESCHEDULE_BOOKING_NOTIFICATIONS_JOB_ID = "booking.send.reschedule.notifications";

export const rescheduleBookingNotificationsJob = defineQueueJob({
  id: RESCHEDULE_BOOKING_NOTIFICATIONS_JOB_ID,
  queue: "notifications",
  retry: bookingNotificationsTaskConfig.retry,
  schema: bookingNotificationTaskSchema,
  run: async (payload) => {
    const { getBookingEmailAndSmsTaskService } = await import(
      "@calcom/features/bookings/di/tasker/BookingEmailAndSmsTaskService.container"
    );

    await getBookingEmailAndSmsTaskService().reschedule(payload);
  },
});
