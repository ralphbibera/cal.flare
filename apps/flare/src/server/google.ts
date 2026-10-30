import { z } from "zod";
import type { AuthEnv } from "./auth.ts";
import { accessToken } from "./auth.ts";
import { ErrorWithCode, nonempty, object } from "./secrets.ts";

export type GoogleFailureKind = "definite" | "retryable" | "ambiguous";
export class GoogleCalendarError extends ErrorWithCode {
  readonly kind: GoogleFailureKind;
  readonly status: number;
  readonly dispatched: boolean;
  constructor(kind: GoogleFailureKind, status: number, message: string, dispatched = true) {
    super("GOOGLE_CALENDAR", message);
    this.kind = kind;
    this.status = status;
    this.dispatched = dispatched;
    this.name = "GoogleCalendarError";
  }
}
export type BusyRange = { start: number; end: number };
type CountedBusyRanges = { ranges: BusyRange[]; received: number };
type PrimaryBusyPage = CountedBusyRanges & { next: string | undefined };
export type ConflictCalendar = { id: string; name: string; primary: boolean };
const calendarId = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\S+$/u)
  .refine((value) => !/\p{Cc}/u.test(value));
const calendarEntry = z.union([
  z.object({ id: calendarId, deleted: z.literal(true) }),
  z.object({
    id: calendarId,
    summary: z
      .string()
      .max(4096)
      .refine((value) => value.trim().length > 0),
    primary: z.boolean().default(false),
    deleted: z.literal(false).optional(),
    hidden: z.boolean().optional(),
    selected: z.boolean().optional(),
    accessRole: z.enum(["none", "freeBusyReader", "reader", "writer", "owner"]),
  }),
]);
const calendarPage = z.object({
  items: z.array(calendarEntry).max(250),
  nextPageToken: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => value.trim().length > 0)
    .optional(),
});
const bookingOwnership = z.object({
  extendedProperties: z.object({
    private: z.object({ application: z.literal("calflare"), booking: z.string() }),
  }),
});
export type EventInput = {
  id: string;
  start: string | number;
  end: string | number;
  timeZone: string;
  title: string;
  description: string;
  attendee: { name: string; email: string };
  privateMetadata: Record<string, string>;
  guests?: readonly string[];
  location?: string;
};
type EventTime = { dateTime: string; timeZone?: string } | { date: string; timeZone?: string };
export type CalendarEvent = {
  id: string;
  etag: string;
  start: EventTime;
  end: EventTime;
  status?: string;
  transparency?: string;
  summary?: string;
  description?: string;
  location?: string;
  attendees: {
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    additionalGuests?: number;
  }[];
  attendeesOmitted?: boolean;
  calendarOwnerEmail?: string;
  extendedProperties: { private: Record<string, string> };
};
const api = "https://www.googleapis.com/calendar/v3";
const events = "/calendars/primary/events";
function instant(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new ErrorWithCode("UPSTREAM_SHAPE", "Expected an ISO timestamp with offset");
  return Date.parse(value);
}
function time(value: unknown): EventTime {
  const data = object(value);
  const zone = data.timeZone === undefined ? {} : { timeZone: nonempty(data.timeZone) };
  if (typeof data.dateTime === "string") {
    instant(data.dateTime);
    return { dateTime: data.dateTime, ...zone };
  }
  if (
    typeof data.date === "string" &&
    /^\d{4}-\d\d-\d\d$/.test(data.date) &&
    new Date(`${data.date}T00:00:00Z`).toISOString().slice(0, 10) === data.date
  )
    return { date: data.date, ...zone };
  throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid Google event time");
}
function attendee(value: unknown): CalendarEvent["attendees"][number] {
  const data = object(value);
  const parsed: CalendarEvent["attendees"][number] = { email: nonempty(data.email) };
  if (data.displayName !== undefined) {
    if (typeof data.displayName !== "string")
      throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid attendee name");
    parsed.displayName = data.displayName;
  }
  if (data.additionalGuests !== undefined) {
    if (
      typeof data.additionalGuests !== "number" ||
      !Number.isSafeInteger(data.additionalGuests) ||
      data.additionalGuests < 0
    )
      throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid additional guests");
    parsed.additionalGuests = data.additionalGuests;
  }
  if (data.responseStatus !== undefined) parsed.responseStatus = nonempty(data.responseStatus);
  if (data.self !== undefined) {
    if (typeof data.self !== "boolean")
      throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid self attendee flag");
    parsed.self = data.self;
  }
  return parsed;
}
function privateMetadata(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (value === undefined) return result;
  const properties = object(value);
  if (properties.private === undefined) return result;
  for (const [key, value] of Object.entries(object(properties.private))) {
    if (typeof value !== "string") throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid event metadata");
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}
function event(value: unknown): CalendarEvent {
  const data = object(value);
  const result: CalendarEvent = {
    id: nonempty(data.id),
    etag: nonempty(data.etag),
    start: time(data.start),
    end: time(data.end),
    attendees: [],
    extendedProperties: { private: {} },
  };
  match(result.etag);
  if (data.attendeesOmitted !== undefined) {
    if (typeof data.attendeesOmitted !== "boolean")
      throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid attendee completeness");
    result.attendeesOmitted = data.attendeesOmitted;
  }
  for (const field of ["status", "transparency", "summary", "description", "location"] as const) {
    if (data[field] !== undefined) {
      if (typeof data[field] !== "string") throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid event text");
      result[field] = data[field];
    }
  }
  if (data.attendees !== undefined) {
    if (!Array.isArray(data.attendees)) throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid event attendees");
    result.attendees = data.attendees.map(attendee);
  }
  result.extendedProperties.private = privateMetadata(data.extendedProperties);
  return result;
}
function interval(from: string, to: string): BusyRange {
  const start = instant(from),
    end = instant(to);
  if (start >= end) throw new ErrorWithCode("INVALID_INTERVAL", "Calendar range must have positive duration");
  return { start, end };
}
function midnight(date: string, zone: string, edge: "start" | "end"): number {
  const naive = Date.parse(`${date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const local = (instant: number): number => {
    const parts = formatter.formatToParts(instant);
    const part = (name: Intl.DateTimeFormatPartTypes): string =>
      nonempty(parts.find((p) => p.type === name)?.value);
    return Date.parse(
      `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}Z`
    );
  };
  const candidates = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = naive + hours * 3600_000;
    candidates.add(naive - (local(probe) - probe));
  }
  const exact = [...candidates].filter((candidate) => local(candidate) === naive);
  // Midnight can be skipped or repeated by a time-zone transition. Widen only that boundary.
  const choices = exact.length ? exact : [...candidates];
  return edge === "start" ? Math.min(...choices) : Math.max(...choices);
}
function clipBusyRange(range: BusyRange, requested: BusyRange): BusyRange | null {
  if (range.start >= requested.end || range.end <= requested.start) return null;
  return { start: Math.max(range.start, requested.start), end: Math.min(range.end, requested.end) };
}
function calendarBusyPeriods(value: unknown): unknown[] {
  const calendar = object(value);
  if (calendar.errors !== undefined && (!Array.isArray(calendar.errors) || calendar.errors.length > 0))
    throw new ErrorWithCode("CALENDAR_BUSY", "Google could not determine calendar availability");
  if (!Array.isArray(calendar.busy)) throw new ErrorWithCode("UPSTREAM_SHAPE", "Missing busy periods");
  return calendar.busy;
}
function freeBusyRanges(value: unknown, ids: string[], requested: BusyRange): CountedBusyRanges {
  const calendars = object(object(value).calendars);
  const ranges: BusyRange[] = [];
  let received = 0;
  for (const id of ids) {
    if (!Object.hasOwn(calendars, id)) throw new ErrorWithCode("UPSTREAM_SHAPE", "Missing calendar");
    const periods = calendarBusyPeriods(calendars[id]);
    received += periods.length;
    if (received > 10_000) throw new ErrorWithCode("CALENDAR_LIMIT", "Google Calendar event limit exceeded");
    for (const value of periods) {
      const period = object(value);
      const range = clipBusyRange(interval(nonempty(period.start), nonempty(period.end)), requested);
      if (range) ranges.push(range);
    }
  }
  return { ranges, received };
}
function primaryEventBusyRange(
  value: unknown,
  pageTimeZone: unknown,
  excludeEventId: string | undefined
): BusyRange | null {
  const item = object(value),
    id = nonempty(item.id);
  const ownership = id === excludeEventId ? bookingOwnership.safeParse(item) : undefined;
  if (
    (ownership?.success && ownership.data.extendedProperties.private.booking === id) ||
    item.status === "cancelled" ||
    item.transparency === "transparent"
  )
    return null;
  const start = time(item.start),
    end = time(item.end);
  if ("date" in start && "date" in end) {
    const zone = nonempty(start.timeZone ?? end.timeZone ?? pageTimeZone);
    const range = { start: midnight(start.date, zone, "start"), end: midnight(end.date, zone, "end") };
    if (range.start >= range.end) throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid all-day interval");
    return range;
  }
  if ("dateTime" in start && "dateTime" in end) return interval(start.dateTime, end.dateTime);
  throw new ErrorWithCode("UPSTREAM_SHAPE", "Mixed event date and timestamp boundaries");
}
function primaryBusyPage(
  value: unknown,
  requested: BusyRange,
  excludeEventId: string | undefined,
  limit: number
): PrimaryBusyPage {
  const data = object(value);
  if (!Array.isArray(data.items)) throw new ErrorWithCode("UPSTREAM_SHAPE", "Missing event list");
  const received = data.items.length;
  if (received > limit) throw new ErrorWithCode("CALENDAR_LIMIT", "Google Calendar event limit exceeded");
  const ranges: BusyRange[] = [];
  for (const value of data.items) {
    const range = primaryEventBusyRange(value, data.timeZone, excludeEventId);
    if (!range) continue;
    const clipped = clipBusyRange(range, requested);
    if (clipped) ranges.push(clipped);
  }
  return {
    ranges,
    received,
    next: data.nextPageToken === undefined ? undefined : nonempty(data.nextPageToken),
  };
}
function body(input: Omit<EventInput, "id">) {
  const start = typeof input.start === "number" ? new Date(input.start).toISOString() : input.start;
  const end = typeof input.end === "number" ? new Date(input.end).toISOString() : input.end;
  interval(start, end);
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format();
  } catch {
    throw new ErrorWithCode("INVALID_EVENT", "Invalid event time zone");
  }
  if (
    !input.timeZone ||
    !input.title.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.attendee.email) ||
    Object.values(input.privateMetadata).some((v) => typeof v !== "string")
  )
    throw new ErrorWithCode("INVALID_EVENT", "Invalid event input");
  if (
    Object.hasOwn(input, "location") &&
    (typeof input.location !== "string" ||
      !input.location.length ||
      input.location.length > 1000 ||
      input.location.trim() !== input.location)
  )
    throw new ErrorWithCode("INVALID_EVENT", "Invalid event location");
  return {
    summary: input.title,
    description: input.description,
    start: { dateTime: start, timeZone: input.timeZone },
    end: { dateTime: end, timeZone: input.timeZone },
    attendees: [
      { email: input.attendee.email, displayName: input.attendee.name },
      ...(input.guests ?? [])
        .filter((email) => email.toLowerCase() !== input.attendee.email.toLowerCase())
        .map((email) => ({ email })),
    ],
    extendedProperties: { private: input.privateMetadata },
    ...(input.location === undefined ? {} : { location: input.location }),
  };
}
function match(etag: string): Record<string, string> {
  if (etag.match(/^"[\x21\x23-\x7e\x80-\xff]*"$/)?.[0] !== etag)
    throw new ErrorWithCode("INVALID_ETAG", "A concrete Google event ETag is required");
  return { "If-Match": etag };
}
async function rateLimited(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) return false;
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const errors = object(object(JSON.parse(new TextDecoder().decode(bytes))).error).errors;
    return (
      Array.isArray(errors) &&
      errors.some((value: unknown) => {
        if (typeof value !== "object" || value === null || !("reason" in value)) return false;
        return value.reason === "rateLimitExceeded" || value.reason === "userRateLimitExceeded";
      })
    );
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class GoogleCalendar {
  private readonly env: AuthEnv;
  private readonly fetcher: typeof fetch;
  constructor(env: AuthEnv, fetcher: typeof fetch = fetch.bind(globalThis)) {
    this.env = env;
    this.fetcher = fetcher;
  }

  private async request(
    path: string,
    method = "GET",
    payload?: unknown,
    headers: Record<string, string> = {},
    allowMissing = false
  ): Promise<Response> {
    let token: string;
    try {
      token = await accessToken(this.env);
    } catch {
      throw new GoogleCalendarError("retryable", 0, "Google credentials are unavailable", false);
    }
    const write = method !== "GET" && path !== "/freeBusy";
    let response: Response;
    try {
      response = await this.fetcher(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...headers,
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GoogleCalendarError(write ? "ambiguous" : "retryable", 0, "Google Calendar transport failed");
    }
    if (response.ok || (allowMissing && (response.status === 404 || response.status === 410)))
      return response;
    const kind =
      response.status >= 500 || response.status === 408
        ? write
          ? "ambiguous"
          : "retryable"
        : response.status === 429 || (response.status === 403 && (await rateLimited(response)))
          ? "retryable"
          : "definite";
    throw new GoogleCalendarError(kind, response.status, `Google Calendar returned ${response.status}`);
  }
  private async parsed<T>(response: Response, write: boolean, parse: (data: unknown) => T): Promise<T> {
    try {
      return parse(await response.json());
    } catch {
      throw new GoogleCalendarError(
        write ? "ambiguous" : "retryable",
        response.status,
        "Invalid Google Calendar response"
      );
    }
  }
  async listCalendars(): Promise<ConflictCalendar[]> {
    const calendars: ConflictCalendar[] = [];
    const ids = new Set<string>(),
      cursors = new Set<string>();
    let page: string | undefined;
    let total = 0;
    let primary = false;
    for (let count = 0; count < 10; count++) {
      const query = new URLSearchParams({ maxResults: "250", showHidden: "true", showDeleted: "false" });
      if (page) query.set("pageToken", page);
      const response = await this.request(`/users/me/calendarList?${query}`);
      const data = await this.parsed(response, false, (value) => {
        const parsed = calendarPage.parse(value);
        total += parsed.items.length;
        if (total > 1000) throw new Error();
        for (const item of parsed.items) {
          if (ids.has(item.id)) throw new Error();
          ids.add(item.id);
          if (item.deleted === true) continue;
          if (item.id === "primary" && !item.primary) throw new Error();
          if (item.primary) {
            if (primary) throw new Error();
            primary = true;
          }
          if (
            item.accessRole === "none" ||
            ["#holiday@group.v.calendar.google.com", "#contacts@group.v.calendar.google.com"].some((suffix) =>
              item.id.endsWith(suffix)
            )
          )
            continue;
          calendars.push({
            id: item.primary ? "primary" : item.id,
            name: item.summary,
            primary: item.primary,
          });
        }
        return parsed;
      });
      if (!data.nextPageToken) return calendars;
      if (cursors.has(data.nextPageToken))
        throw new GoogleCalendarError("retryable", 200, "Google repeated a pagination cursor");
      cursors.add(data.nextPageToken);
      page = data.nextPageToken;
    }
    throw new GoogleCalendarError("retryable", 200, "Google Calendar pagination limit exceeded");
  }
  async freeBusy(fromISO: string, toISO: string, ids: string[] = ["primary"]): Promise<BusyRange[]> {
    return (await this.readFreeBusy(fromISO, toISO, ids)).ranges;
  }
  private async readFreeBusy(fromISO: string, toISO: string, ids: string[]): Promise<CountedBusyRanges> {
    const requested = interval(fromISO, toISO);
    z.array(calendarId).max(50).parse(ids);
    if (!ids.length) return { ranges: [], received: 0 };
    const response = await this.request("/freeBusy", "POST", {
      timeMin: fromISO,
      timeMax: toISO,
      calendarExpansionMax: 50,
      items: ids.map((id) => ({ id })),
    });
    return this.parsed(response, false, (value) => freeBusyRanges(value, ids, requested));
  }
  async busy(
    fromISO: string,
    toISO: string,
    excludeEventId?: string,
    conflictCalendarIds?: string[]
  ): Promise<BusyRange[]> {
    interval(fromISO, toISO);
    const ids = conflictCalendarIds ?? ["primary"];
    const secondary = ids.filter((id) => id !== "primary");
    const result = secondary.length
      ? await this.readFreeBusy(fromISO, toISO, secondary)
      : { ranges: [], received: 0 };
    if (!ids.includes("primary")) return result.ranges;
    const primary = await this.primaryBusy(fromISO, toISO, excludeEventId, 10_000 - result.received);
    return [...result.ranges, ...primary];
  }
  private async primaryBusy(
    fromISO: string,
    toISO: string,
    excludeEventId: string | undefined,
    limit: number
  ): Promise<BusyRange[]> {
    const requested = interval(fromISO, toISO),
      result: BusyRange[] = [];
    const seen = new Set<string>();
    let page: string | undefined;
    let total = 0;
    for (let count = 0; count < 10; count++) {
      const query = new URLSearchParams({
        timeMin: fromISO,
        timeMax: toISO,
        singleEvents: "true",
        showDeleted: "false",
        maxResults: "2500",
      });
      if (page) query.set("pageToken", page);
      const response = await this.request(`${events}?${query}`);
      const parsed = await this.parsed(response, false, (value) =>
        primaryBusyPage(value, requested, excludeEventId, limit - total)
      );
      total += parsed.received;
      result.push(...parsed.ranges);
      if (!parsed.next) return result;
      if (seen.has(parsed.next))
        throw new GoogleCalendarError("retryable", 200, "Google repeated a pagination cursor");
      seen.add(parsed.next);
      page = parsed.next;
    }
    throw new GoogleCalendarError("retryable", 200, "Google Calendar pagination limit exceeded");
  }
  async insert(input: EventInput): Promise<{ id: string; etag: string }> {
    if (!/^[0-9a-v]{5,1024}$/.test(input.id))
      throw new ErrorWithCode("INVALID_EVENT", "Event ID must use Google base32hex syntax");
    const response = await this.request(`${events}?sendUpdates=all`, "POST", {
      ...body(input),
      id: input.id,
    });
    return this.parsed(response, true, (value) => {
      const data = object(value);
      if (data.id !== input.id) throw new Error();
      const etag = nonempty(data.etag);
      match(etag);
      return { id: input.id, etag };
    });
  }
  async get(id: string): Promise<CalendarEvent | null> {
    const response = await this.request(
      `${events}/${encodeURIComponent(nonempty(id))}`,
      "GET",
      undefined,
      {},
      true
    );
    if (response.status === 404 || response.status === 410) {
      const probe = await this.request(`${events}?maxResults=1`);
      await this.parsed(probe, false, (value) => {
        if (!Array.isArray(object(value).items))
          throw new ErrorWithCode("UPSTREAM_SHAPE", "Calendar access could not be verified");
      });
      return null;
    }
    return this.parsed(response, false, (value) => {
      const data = object(value);
      if (data.id !== id) throw new Error();
      if (data.status === "cancelled") return null;
      const parsed = event(value);
      if (parsed.id !== id) throw new Error();
      parsed.calendarOwnerEmail = this.env.GOOGLE_OWNER_EMAIL;
      return parsed;
    });
  }
  async update(
    id: string,
    etag: string,
    input: Omit<EventInput, "id">
  ): Promise<{ id: string; etag: string }> {
    const response = await this.request(
      `${events}/${encodeURIComponent(nonempty(id))}?sendUpdates=all`,
      "PATCH",
      body(input),
      match(etag)
    );
    return this.parsed(response, true, (value) => {
      const data = object(value);
      if (data.id !== id) throw new Error();
      const etag = nonempty(data.etag);
      match(etag);
      return { id, etag };
    });
  }
  async delete(id: string, etag: string): Promise<void> {
    await this.request(
      `${events}/${encodeURIComponent(nonempty(id))}?sendUpdates=all`,
      "DELETE",
      undefined,
      match(etag)
    );
  }
}
