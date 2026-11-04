import { z } from "zod";

const availabilityDaysSchema = z.number().int().min(-2147483648).max(2147483647).array();

export function parseAvailability<T extends { days: unknown }>(availability: T) {
  return { ...availability, days: availabilityDaysSchema.parse(availability.days === null ? [] : availability.days) };
}

export function parseScheduleAvailability<T extends { availability: { days: unknown }[] }>(schedule: T) {
  return { ...schedule, availability: schedule.availability.map(parseAvailability) };
}

export function parseUserAvailability<
  T extends { availability: { days: unknown }[]; schedules: { availability: { days: unknown }[] }[] },
>(user: T) {
  return {
    ...parseScheduleAvailability(user),
    schedules: user.schedules.map(parseScheduleAvailability),
  };
}
