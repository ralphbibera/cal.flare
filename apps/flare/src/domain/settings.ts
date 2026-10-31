type BookingWindowRange = { start: string; end: string };
type EventSettings = {
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  intervalMinutes: number;
  beforeMinutes: number;
  afterMinutes: number;
  noticeMinutes: number;
  disableCancelling?: boolean;
  disableRescheduling?: boolean;
  minimumRescheduleNotice?: number;
  bookingWindowDays?: number;
  bookingWindowRange?: BookingWindowRange;
  location?: string;
};

const DEFAULT_EVENT_ID = "default";
type OwnerEvent = { id: string; event: EventSettings; lifecycle: "listed" | "hidden" };
type OwnerEventMode =
  | { kind: "create" }
  | { kind: "duplicate"; id: string }
  | { kind: "edit"; id: string; lifecycle: OwnerEvent["lifecycle"] };
export type AvailabilitySchedule = { id: string; name: string; schedule: Settings["schedule"] };
export function isScheduleId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "legacy" ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
  );
}
function isEventId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === DEFAULT_EVENT_ID ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
  );
}

type MinuteRange = { startMinute: number; endMinute: number };
type EventDetails = Pick<EventSettings, "slug" | "title" | "description" | "durationMinutes" | "location">;
type OptionalEventPolicy = Pick<
  EventSettings,
  | "disableCancelling"
  | "disableRescheduling"
  | "bookingWindowDays"
  | "bookingWindowRange"
  | "minimumRescheduleNotice"
>;
type BookingRules = Required<
  Pick<
    EventSettings,
    | "intervalMinutes"
    | "beforeMinutes"
    | "afterMinutes"
    | "noticeMinutes"
    | "disableCancelling"
    | "disableRescheduling"
  >
> & {
  bookingWindowDays?: number | null;
  bookingWindowRange?: BookingWindowRange | null;
  minimumRescheduleNotice?: number | null;
};
type Settings = {
  event: EventSettings;
  schedule: {
    timeZone: string;
    rules: (MinuteRange & { weekday: number })[];
    overrides?: { date: string; ranges: MinuteRange[] }[];
  };
  conflictCalendarIds?: string[];
};
type WeeklySchedule = Pick<Settings["schedule"], "timeZone" | "rules">;
type ScheduleOverrides = { overrides: NonNullable<Settings["schedule"]["overrides"]> };

class SettingsError extends Error {
  readonly code = "INVALID_SETTINGS";

  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

function object(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SettingsError(`${path} must be an object`);
  }
  return Object.fromEntries(Object.entries(input));
}

function text(input: unknown, path: string, max: number, min: number = 0): string {
  if (typeof input !== "string" || input.length < min || input.length > max) {
    throw new SettingsError(`${path} must be a string of ${min} to ${max} characters`);
  }
  return input;
}

function integer(input: unknown, path: string, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < min || input > max) {
    throw new SettingsError(`${path} must be an integer between ${min} and ${max}`);
  }
  return input;
}

const MAX_RESCHEDULE_NOTICE_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

function rescheduleNotice(input: unknown): number {
  return integer(input, "minimumRescheduleNotice", 0, MAX_RESCHEDULE_NOTICE_MINUTES);
}

function isWithinMinimumRescheduleNotice(start: number, now: number, minutes?: number): boolean {
  const remaining = start - now;
  return minutes !== undefined && minutes > 0 && remaining > 0 && remaining < minutes * 60_000;
}

function locationText(input: unknown): string {
  if (typeof input !== "string") throw new SettingsError("location must be a string");
  return text(input.trim(), "location", 1000);
}

function list(input: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) {
    throw new SettingsError(`${path} must be an array with at most ${max} entries`);
  }
  return input;
}

function parseConflictCalendarIds(input: unknown): string[] {
  const ids = list(input, "conflictCalendarIds", 50).map((value) => {
    const id = text(value, "calendar ID", 1024, 1);
    if (/\s|\p{Cc}/u.test(id)) throw new SettingsError("Invalid calendar ID");
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new SettingsError("Duplicate calendar IDs");
  return ids.sort();
}

function parseConflictCalendars(input: unknown): string[] | null {
  const value = object(input, "conflict calendars");
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "conflictCalendarIds"))
    throw new SettingsError("Conflict calendars require only conflictCalendarIds");
  return value.conflictCalendarIds === null ? null : parseConflictCalendarIds(value.conflictCalendarIds);
}

function range(input: unknown): MinuteRange {
  const value = object(input, "range");
  const startMinute = integer(value.startMinute, "startMinute", 0, 1439);
  return { startMinute, endMinute: integer(value.endMinute, "endMinute", startMinute + 1, 1440) };
}

function rejectOverlaps(ranges: MinuteRange[]): void {
  const sorted = [...ranges].sort((a, b) => a.startMinute - b.startMinute);
  let end = -1;
  for (const item of sorted) {
    if (item.startMinute < end) throw new SettingsError("Working ranges must not overlap or duplicate");
    end = item.endMinute;
  }
}

function parseOptionalEventPolicy(event: Record<string, unknown>): OptionalEventPolicy {
  const policy: OptionalEventPolicy = {};
  const flags: ("disableCancelling" | "disableRescheduling")[] = ["disableCancelling", "disableRescheduling"];
  for (const key of flags) {
    if (event[key] !== undefined) {
      if (typeof event[key] !== "boolean") throw new SettingsError(`${key} must be a boolean`);
      policy[key] = event[key];
    }
  }
  if (Object.hasOwn(event, "bookingWindowDays")) {
    policy.bookingWindowDays = integer(event.bookingWindowDays, "bookingWindowDays", 1, 365);
  }
  if (Object.hasOwn(event, "minimumRescheduleNotice")) {
    policy.minimumRescheduleNotice = rescheduleNotice(event.minimumRescheduleNotice);
  }
  if (Object.hasOwn(event, "bookingWindowRange")) {
    policy.bookingWindowRange = parseBookingWindowRange(event.bookingWindowRange);
    if (policy.bookingWindowDays !== undefined)
      throw new SettingsError("Booking windows are mutually exclusive");
  }
  return policy;
}

function bookingDate(input: unknown): string {
  if (typeof input !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(input))
    throw new SettingsError("Booking dates require YYYY-MM-DD within 2000..2099");
  const parsed = new Date(`${input}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input)
    throw new SettingsError("Booking dates must be real calendar dates");
  return input;
}

function parseBookingWindowRange(input: unknown): BookingWindowRange {
  const value = object(input, "bookingWindowRange");
  if (Object.keys(value).some((key) => !["start", "end"].includes(key)))
    throw new SettingsError("Booking date range requires only start and end");
  const start = bookingDate(value.start),
    end = bookingDate(value.end);
  if (start > end) throw new SettingsError("Booking date range start must not follow end");
  return { start, end };
}

function parseDatedOverrides(input: unknown): ScheduleOverrides["overrides"] {
  const dates = new Set<string>();
  return list(input, "overrides", 366).map((input) => {
    const override = object(input, "override");
    const date = text(override.date, "date", 10, 10);
    const parsed = new Date(`${date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date ||
      dates.has(date)
    ) {
      throw new SettingsError("Overrides require unique valid YYYY-MM-DD dates");
    }
    dates.add(date);
    const ranges = list(override.ranges, "ranges", 100).map(range);
    rejectOverlaps(ranges);
    return { date, ranges };
  });
}

function parseSettings(input: unknown): Settings {
  const root = object(input, "settings");
  const event = object(root.event, "event");
  const schedule = object(root.schedule, "schedule");
  const slug = text(event.slug, "slug", 100, 1);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new SettingsError("slug must contain lowercase letters, digits, and single separating hyphens");
  }
  if (slug === "api") throw new SettingsError("slug is reserved for application routes");
  const title = text(event.title, "title", 100, 1);
  if (!title.trim()) throw new SettingsError("title must not be blank");
  const timeZone = text(schedule.timeZone, "timeZone", 100, 1);
  try {
    if (/^[+-]/.test(timeZone)) throw new RangeError();
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new SettingsError("timeZone must be a valid IANA time zone");
  }
  const rules = list(schedule.rules, "rules", 28).map((input) => {
    const rule = object(input, "rule");
    return { weekday: integer(rule.weekday, "weekday", 0, 6), ...range(rule) };
  });
  for (let weekday = 0; weekday < 7; weekday++) {
    rejectOverlaps(rules.filter((rule) => rule.weekday === weekday));
  }
  const result: Settings = {
    event: {
      slug,
      title,
      description: text(event.description, "description", 2000),
      durationMinutes: integer(event.durationMinutes, "durationMinutes", 5, 480),
      intervalMinutes: integer(event.intervalMinutes, "intervalMinutes", 5, 240),
      beforeMinutes: integer(event.beforeMinutes, "beforeMinutes", 0, 120),
      afterMinutes: integer(event.afterMinutes, "afterMinutes", 0, 120),
      noticeMinutes: integer(event.noticeMinutes, "noticeMinutes", 0, 43200),
      ...parseOptionalEventPolicy(event),
    },
    schedule: { timeZone, rules },
  };
  if (Object.hasOwn(event, "location")) {
    const location = locationText(event.location);
    if (location) result.event.location = location;
  }
  if (schedule.overrides !== undefined) {
    result.schedule.overrides = parseDatedOverrides(schedule.overrides);
  }
  if (Object.hasOwn(root, "conflictCalendarIds"))
    result.conflictCalendarIds = parseConflictCalendarIds(root.conflictCalendarIds);
  return result;
}

const defaultSettings: Settings = {
  event: {
    slug: "intro",
    title: "Intro call",
    description: "",
    durationMinutes: 30,
    intervalMinutes: 30,
    beforeMinutes: 0,
    afterMinutes: 0,
    noticeMinutes: 120,
  },
  schedule: {
    timeZone: "UTC",
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
  },
};

function parseEventDetails(input: unknown): EventDetails {
  const value = object(input, "event details");
  if (
    Object.keys(value).some(
      (key) => !["slug", "title", "description", "durationMinutes", "location"].includes(key)
    )
  ) {
    throw new SettingsError("Event details contain an unsupported field");
  }
  const { slug, title, description, durationMinutes } = parseSettings({
    ...defaultSettings,
    event: {
      ...defaultSettings.event,
      slug: value.slug,
      title: value.title,
      description: value.description,
      durationMinutes: value.durationMinutes,
    },
  }).event;
  return {
    slug,
    title,
    description,
    durationMinutes,
    ...(Object.hasOwn(value, "location") ? { location: locationText(value.location) } : {}),
  };
}

function parseWeeklySchedule(input: unknown): WeeklySchedule {
  const value = object(input, "weekly schedule");
  if (Object.keys(value).some((key) => !["timeZone", "rules"].includes(key))) {
    throw new SettingsError("Weekly schedule contains an unsupported field");
  }
  const { timeZone, rules } = parseSettings({
    ...defaultSettings,
    schedule: { timeZone: value.timeZone, rules: value.rules },
  }).schedule;
  return { timeZone, rules };
}

function parseScheduleOverrides(input: unknown): ScheduleOverrides {
  const value = object(input, "schedule overrides");
  if (Object.keys(value).some((key) => key !== "overrides") || !Array.isArray(value.overrides)) {
    throw new SettingsError("Schedule overrides require only an overrides array");
  }
  const { overrides = [] } = parseSettings({
    ...defaultSettings,
    schedule: { ...defaultSettings.schedule, overrides: value.overrides },
  }).schedule;
  return { overrides };
}

function parseBookingRules(input: unknown): BookingRules {
  const value = object(input, "booking rules");
  const { disableCancelling, disableRescheduling } = value;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "intervalMinutes",
          "beforeMinutes",
          "afterMinutes",
          "noticeMinutes",
          "disableCancelling",
          "disableRescheduling",
          "bookingWindowDays",
          "bookingWindowRange",
          "minimumRescheduleNotice",
        ].includes(key)
    ) ||
    typeof disableCancelling !== "boolean" ||
    typeof disableRescheduling !== "boolean"
  ) {
    throw new SettingsError("Booking rules require timing fields and explicit policy booleans");
  }
  const event = parseSettings({
    ...defaultSettings,
    event: {
      ...defaultSettings.event,
      intervalMinutes: value.intervalMinutes,
      beforeMinutes: value.beforeMinutes,
      afterMinutes: value.afterMinutes,
      noticeMinutes: value.noticeMinutes,
      disableCancelling,
      disableRescheduling,
    },
  }).event;
  if (value.bookingWindowDays != null && value.bookingWindowRange != null)
    throw new SettingsError("Booking windows are mutually exclusive");
  return {
    intervalMinutes: event.intervalMinutes,
    beforeMinutes: event.beforeMinutes,
    afterMinutes: event.afterMinutes,
    noticeMinutes: event.noticeMinutes,
    disableCancelling,
    disableRescheduling,
    ...(Object.hasOwn(value, "minimumRescheduleNotice")
      ? {
          minimumRescheduleNotice:
            value.minimumRescheduleNotice === null ? null : rescheduleNotice(value.minimumRescheduleNotice),
        }
      : {}),
    ...(Object.hasOwn(value, "bookingWindowDays")
      ? {
          bookingWindowDays:
            value.bookingWindowDays === null
              ? null
              : integer(value.bookingWindowDays, "bookingWindowDays", 1, 365),
        }
      : {}),
    ...(Object.hasOwn(value, "bookingWindowRange")
      ? {
          bookingWindowRange:
            value.bookingWindowRange === null ? null : parseBookingWindowRange(value.bookingWindowRange),
        }
      : {}),
  };
}

export type {
  BookingRules,
  BookingWindowRange,
  EventDetails,
  EventSettings,
  OwnerEvent,
  OwnerEventMode,
  ScheduleOverrides,
  Settings,
  WeeklySchedule,
};
export {
  MAX_RESCHEDULE_NOTICE_MINUTES,
  isWithinMinimumRescheduleNotice,
  DEFAULT_EVENT_ID,
  isEventId,
  defaultSettings,
  parseBookingRules,
  parseBookingWindowRange,
  parseConflictCalendarIds,
  parseConflictCalendars,
  parseEventDetails,
  parseScheduleOverrides,
  parseSettings,
  parseWeeklySchedule,
  SettingsError,
};
