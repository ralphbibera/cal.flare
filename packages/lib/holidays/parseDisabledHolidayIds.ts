import { z } from "zod";

const disabledHolidayIds = z.array(z.string());

export function parseDisabledHolidayIds(value: unknown): string[] {
  return disabledHolidayIds.parse(value === null ? [] : value);
}
