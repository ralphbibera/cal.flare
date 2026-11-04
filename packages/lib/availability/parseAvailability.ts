import { z } from "zod";

const availabilityDaysSchema = z.number().int().min(-2147483648).max(2147483647).array();

export function parseAvailability<T extends { days: unknown }>(availability: T) {
  const { days, ...rest } = availability;
  return { ...rest, days: availabilityDaysSchema.parse(days === null ? [] : days) };
}

export function parseScheduleAvailability<T extends { availability: { days: unknown }[] }>(schedule: T) {
  const { availability, ...rest } = schedule;
  return {
    ...rest,
    availability: availability.map((row: T["availability"][number]) => parseAvailability(row)),
  };
}

export function parseUserAvailability<
  T extends { availability: { days: unknown }[]; schedules: { availability: { days: unknown }[] }[] },
>(user: T) {
  const { schedules, ...rest } = user;
  return {
    ...parseScheduleAvailability(rest),
    schedules: schedules.map((schedule: T["schedules"][number]) => parseScheduleAvailability(schedule)),
  };
}
