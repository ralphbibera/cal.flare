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
export type EventInput = {
  id: string;
  start: string | number;
  end: string | number;
  timeZone: string;
  title: string;
  description: string;
  attendee: { name: string; email: string };
  privateMetadata: Record<string, string>;
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
  attendees: { email: string; displayName?: string; responseStatus?: string; self?: boolean }[];
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
  for (const field of ["status", "transparency", "summary", "description"] as const) {
    if (data[field] !== undefined) {
      if (typeof data[field] !== "string") throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid event text");
      result[field] = data[field];
    }
  }
  if (data.attendees !== undefined) {
    if (!Array.isArray(data.attendees)) throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid event attendees");
    result.attendees = data.attendees.map((value: unknown) => {
      const attendee = object(value);
      const parsed: CalendarEvent["attendees"][number] = { email: nonempty(attendee.email) };
      if (attendee.displayName !== undefined) parsed.displayName = nonempty(attendee.displayName);
      if (attendee.responseStatus !== undefined) parsed.responseStatus = nonempty(attendee.responseStatus);
      if (attendee.self !== undefined) {
        if (typeof attendee.self !== "boolean")
          throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid self attendee flag");
        parsed.self = attendee.self;
      }
      return parsed;
    });
  }
  if (data.extendedProperties !== undefined) {
    const properties = object(data.extendedProperties);
    if (properties.private !== undefined)
      for (const [key, value] of Object.entries(object(properties.private))) {
        if (typeof value !== "string") throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid event metadata");
        Object.defineProperty(result.extendedProperties.private, key, { value, enumerable: true });
      }
  }
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
  return {
    summary: input.title,
    description: input.description,
    start: { dateTime: start, timeZone: input.timeZone },
    end: { dateTime: end, timeZone: input.timeZone },
    attendees: [{ email: input.attendee.email, displayName: input.attendee.name }],
    extendedProperties: { private: input.privateMetadata },
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
  async freeBusy(fromISO: string, toISO: string): Promise<BusyRange[]> {
    interval(fromISO, toISO);
    const response = await this.request("/freeBusy", "POST", {
      timeMin: fromISO,
      timeMax: toISO,
      items: [{ id: "primary" }],
    });
    return this.parsed(response, false, (value) => {
      const primary = object(object(object(value).calendars).primary);
      if (primary.errors !== undefined && (!Array.isArray(primary.errors) || primary.errors.length > 0))
        throw new ErrorWithCode("CALENDAR_BUSY", "Google could not determine calendar availability");
      if (!Array.isArray(primary.busy)) throw new ErrorWithCode("UPSTREAM_SHAPE", "Missing busy periods");
      return primary.busy.map((value: unknown) => {
        const range = object(value);
        return interval(nonempty(range.start), nonempty(range.end));
      });
    });
  }
  async busy(fromISO: string, toISO: string, excludeEventId?: string): Promise<BusyRange[]> {
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
      const parsed = await this.parsed(response, false, (value) => {
        const data = object(value);
        if (!Array.isArray(data.items)) throw new ErrorWithCode("UPSTREAM_SHAPE", "Missing event list");
        total += data.items.length;
        if (total > 10_000) throw new ErrorWithCode("CALENDAR_LIMIT", "Google Calendar event limit exceeded");
        const ranges: BusyRange[] = [];
        for (const value of data.items) {
          const item = object(value),
            id = nonempty(item.id);
          if (id === excludeEventId || item.status === "cancelled" || item.transparency === "transparent")
            continue;
          const start = time(item.start),
            end = time(item.end);
          let range: BusyRange;
          if ("date" in start && "date" in end) {
            const zone = nonempty(start.timeZone ?? end.timeZone ?? data.timeZone);
            range = { start: midnight(start.date, zone, "start"), end: midnight(end.date, zone, "end") };
            if (range.start >= range.end)
              throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid all-day interval");
          } else if ("dateTime" in start && "dateTime" in end) {
            range = interval(start.dateTime, end.dateTime);
          } else throw new ErrorWithCode("UPSTREAM_SHAPE", "Mixed event date and timestamp boundaries");
          if (range.start < requested.end && range.end > requested.start)
            ranges.push({
              start: Math.max(range.start, requested.start),
              end: Math.min(range.end, requested.end),
            });
        }
        return { ranges, next: data.nextPageToken === undefined ? undefined : nonempty(data.nextPageToken) };
      });
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
