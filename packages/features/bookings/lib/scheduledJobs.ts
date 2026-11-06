import { z } from "zod";

const scheduledJobsSchema = z.array(z.string());

export function parseBookingScheduledJobs<T extends { scheduledJobs: unknown }>(booking: T) {
  const { scheduledJobs, ...rest } = booking;
  return {
    ...rest,
    scheduledJobs: scheduledJobsSchema.parse(scheduledJobs === null ? [] : scheduledJobs),
  };
}
