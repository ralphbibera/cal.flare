import type { AvailabilityInput } from "./scheduling.ts";

export function bookingWindow(input: AvailabilityInput): (start: number) => "before" | "within" | "after" {
  const { policy } = input;
  const fixed = policy.bookingWindowRange;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: fixed ? input.schedule.timeZone : (input.windowTimeZone ?? input.visitorTimeZone),
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const calendarDay = (timestamp: number): number => {
    const fields = Object.fromEntries(
      formatter.formatToParts(timestamp).map((part) => [part.type, part.value])
    );
    return Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day));
  };
  if (fixed) {
    const first = Date.parse(`${fixed.start}T00:00:00Z`),
      last = Date.parse(`${fixed.end}T00:00:00Z`);
    return (start: number) => {
      const day = calendarDay(start);
      if (day < first) return "before";
      if (day > last) return "after";
      return "within";
    };
  }
  if (policy.bookingWindowDays === undefined) return () => "within";
  const last = calendarDay(input.now) + policy.bookingWindowDays * 86_400_000;
  return (start: number) => (calendarDay(start) <= last ? "within" : "after");
}
