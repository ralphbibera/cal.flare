import { defineQueueJob } from "@calcom/features/tasker/queue/JobQueue";
import { bookingNotificationsTaskConfig } from "./config";
import { bookingNotificationTaskSchema } from "./schema";

export const CONFIRM_BOOKING_NOTIFICATIONS_JOB_ID = "booking.send.confirm.notifications";

export const confirmBookingNotificationsJob = defineQueueJob({
  id: CONFIRM_BOOKING_NOTIFICATIONS_JOB_ID,
  queue: "notifications",
  retry: bookingNotificationsTaskConfig.retry,
  schema: bookingNotificationTaskSchema,
  run: async (payload) => {
    const { getBookingEmailAndSmsTaskService } = await import(
      "@calcom/features/bookings/di/tasker/BookingEmailAndSmsTaskService.container"
    );

    await getBookingEmailAndSmsTaskService().confirm(payload);
  },
});
