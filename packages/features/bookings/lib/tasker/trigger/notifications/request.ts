import { defineQueueJob } from "@calcom/features/tasker/queue/JobQueue";
import { bookingNotificationsTaskConfig } from "./config";
import { bookingNotificationTaskSchema } from "./schema";

export const REQUEST_BOOKING_NOTIFICATIONS_JOB_ID = "booking.send.request.notifications";

export const requestBookingNotificationsJob = defineQueueJob({
  id: REQUEST_BOOKING_NOTIFICATIONS_JOB_ID,
  queue: "notifications",
  retry: bookingNotificationsTaskConfig.retry,
  schema: bookingNotificationTaskSchema,
  run: async (payload) => {
    const { getBookingEmailAndSmsTaskService } = await import(
      "@calcom/features/bookings/di/tasker/BookingEmailAndSmsTaskService.container"
    );

    await getBookingEmailAndSmsTaskService().request(payload);
  },
});
