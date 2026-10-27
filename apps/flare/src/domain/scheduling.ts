type Interval = { start: number; end: number };
type WorkingRule = { weekday: number; startMinute: number; endMinute: number };
type WorkingRange = Pick<WorkingRule, "startMinute" | "endMinute">;
type Schedule = {
  timeZone: string;
  rules: WorkingRule[];
  overrides?: { date: string; ranges: WorkingRange[] }[];
};
type SlotPolicy = {
  durationMinutes: number;
  intervalMinutes: number;
  beforeMinutes: number;
  afterMinutes: number;
  noticeMinutes: number;
};
type AvailabilityInput = {
  schedule: Schedule;
  visitorTimeZone: string;
  policy: SlotPolicy;
  from: number;
  to: number;
  now: number;
  busy: Interval[];
};

const MINUTE = 60_000;
const DAY: number = 1440 * MINUTE;
const EARLIEST: number = Date.UTC(2000, 0, 1);
const LATEST: number = Date.UTC(2100, 0, 1);

function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function integer(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function validateRange(range: WorkingRange): void {
  integer(range.startMinute, 0, 1439, "startMinute");
  integer(range.endMinute, range.startMinute + 1, 1440, "endMinute");
}

function validate(input: AvailabilityInput): void {
  const { schedule, policy, from, to, now, busy } = input;
  if (!isValidTimeZone(schedule.timeZone)) throw new RangeError("Invalid IANA time zone");
  if (!isValidTimeZone(input.visitorTimeZone)) throw new RangeError("Invalid visitor time zone");
  for (const value of [from, to, now]) integer(value, EARLIEST, LATEST, "timestamp");
  if (to <= from || to - from > 31 * DAY) throw new RangeError("Query must span (0, 31] days");
  integer(policy.durationMinutes, 1, 1440, "durationMinutes");
  integer(policy.intervalMinutes, 1, 1440, "intervalMinutes");
  for (const value of [policy.beforeMinutes, policy.afterMinutes, policy.noticeMinutes]) {
    integer(value, 0, 31 * 1440, "buffer or notice minutes");
  }
  if (schedule.rules.length > 100 || (schedule.overrides?.length ?? 0) > 366 || busy.length > 10_000) {
    throw new RangeError("Too many rules, overrides, or busy intervals");
  }
  for (const rule of schedule.rules) {
    integer(rule.weekday, 0, 6, "weekday");
    validateRange(rule);
  }
  const dates = new Set<string>();
  for (const override of schedule.overrides ?? []) {
    const parsed = new Date(`${override.date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(override.date) ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== override.date ||
      dates.has(override.date) ||
      override.ranges.length > 100
    ) {
      throw new RangeError("Overrides require unique valid YYYY-MM-DD dates and at most 100 ranges");
    }
    dates.add(override.date);
    override.ranges.forEach(validateRange);
  }
  for (const interval of busy) {
    integer(interval.start, EARLIEST, LATEST, "busy start");
    integer(interval.end, EARLIEST, LATEST, "busy end");
    if (interval.end <= interval.start) throw new RangeError("Busy intervals must have positive duration");
  }
}

function availableSlots(input: AvailabilityInput): Interval[] {
  validate(input);
  const { schedule, policy, from, to, now, busy } = input;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const overrides = new Map((schedule.overrides ?? []).map((item) => [item.date, item.ranges]));
  const weekly = Array.from({ length: 7 }, (_, weekday) =>
    schedule.rules.filter((rule) => rule.weekday === weekday)
  );
  const first = Math.ceil(from / MINUTE) * MINUTE;
  const count = Math.max(0, Math.floor((to - first) / MINUTE));
  const working: Interval[] = [];
  const localTimeAt = (timestamp: number): number => {
    const fields = Object.fromEntries(
      formatter.formatToParts(timestamp).map((part) => [part.type, part.value])
    );
    return Date.UTC(
      Number(fields.year),
      Number(fields.month) - 1,
      Number(fields.day),
      Number(fields.hour),
      Number(fields.minute)
    );
  };
  let ranges: WorkingRange[] = [];
  let localTime = 0;
  let transitionHour = false;
  let cachedDay = Number.NaN;
  // Supported IANA transitions are more than an hour apart, so equal endpoint
  // offsets permit arithmetic; a changed offset keeps the exact minute scan.
  for (let index = 0; index < count; index++) {
    const timestamp = first + index * MINUTE;
    if (index % 60 === 0) {
      localTime = localTimeAt(timestamp);
      const last = first + Math.min(index + 59, count - 1) * MINUTE;
      transitionHour = localTimeAt(last) - localTime !== last - timestamp;
    } else if (transitionHour) {
      localTime = localTimeAt(timestamp);
    } else {
      localTime += MINUTE;
    }
    const day = Math.floor(localTime / DAY);
    if (day !== cachedDay) {
      cachedDay = day;
      const date = new Date(day * DAY);
      ranges = overrides.get(date.toISOString().slice(0, 10)) ?? weekly[date.getUTCDay()] ?? [];
    }
    const minute = (localTime - day * DAY) / MINUTE;
    if (ranges.some((range) => range.startMinute <= minute && minute < range.endMinute)) {
      const previous = working.at(-1);
      if (previous?.end === timestamp) previous.end += MINUTE;
      else working.push({ start: timestamp, end: timestamp + MINUTE });
    }
  }
  const blocked = busy
    .map((interval) => ({
      start: interval.start - policy.afterMinutes * MINUTE,
      end: interval.end + policy.beforeMinutes * MINUTE,
    }))
    .sort((a, b) => a.start - b.start);
  const free: Interval[] = [];
  for (const range of working) {
    let cursor = range.start;
    for (const block of blocked) {
      if (block.end <= cursor) continue;
      if (block.start >= range.end) break;
      if (cursor < block.start) free.push({ start: cursor, end: block.start });
      cursor = Math.max(cursor, block.end);
      if (cursor >= range.end) break;
    }
    if (cursor < range.end) free.push({ start: cursor, end: range.end });
  }
  const rounding = [60, 30, 20, 15, 10, 5].find((value) => policy.intervalMinutes % value === 0) ?? 1;
  const visitorMinute = new Intl.DateTimeFormat("en-US", {
    timeZone: input.visitorTimeZone,
    minute: "numeric",
    numberingSystem: "latn",
  });
  const slots: Interval[] = [];
  const duration = policy.durationMinutes * MINUTE;
  for (const range of free) {
    let start = Math.ceil(Math.max(range.start, now + policy.noticeMinutes * MINUTE) / MINUTE) * MINUTE;
    if (start + duration > range.end) continue;
    // Upstream rounds in the visitor zone after subtraction. A midnight grid
    // shifts 40-minute slots and misses valid starts at free-range boundaries.
    const minute = Number(visitorMinute.format(start));
    start += ((rounding - (minute % rounding)) % rounding) * MINUTE;
    const previous = slots.at(-1);
    if (previous) start = Math.max(start, previous.start + policy.intervalMinutes * MINUTE);
    for (; start + duration <= range.end; start += policy.intervalMinutes * MINUTE) {
      slots.push({ start, end: start + duration });
    }
  }
  return slots;
}

export { availableSlots, isValidTimeZone, overlaps };
export type { AvailabilityInput, Interval, Schedule, SlotPolicy, WorkingRule };
