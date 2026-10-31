import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { parseRescheduleReason } from "../domain/reschedule-reason.ts";
import type { Interval } from "../domain/scheduling.ts";
import { isValidTimeZone, MAX_QUERY_DAYS } from "../domain/scheduling.ts";
import type {
  AvailabilitySchedule,
  BookingRules,
  EventDetails,
  OwnerEvent,
  ScheduleOverrides,
  Settings,
  WeeklySchedule,
} from "../domain/settings.ts";
import { defaultSettings, isEventId, isScheduleId, parseSettings } from "../domain/settings.ts";
import type { BookingView, parseChange, parseCreate } from "../server/booking-model.ts";

type Transport = (path: string, init: RequestInit) => Promise<Response>;
type CreateRequest = Omit<ReturnType<typeof parseCreate>, "action">;
type ChangeRequest = ReturnType<typeof parseChange>;
type BookingAccess = { id: string; token: string };
type PublicBooking = Settings & { organizer: { name: string } };
type EventAccess = { kind: "event"; id: string };
type CalendarAccess = BookingAccess | EventAccess | { kind: "owner"; id: string };
export type ScheduleCatalog = { defaultScheduleId: string; schedules: AvailabilitySchedule[] };

function schedulePath(id: string): string {
  if (!isScheduleId(id)) throw new ErrorWithCode("invalid_schedule", 400);
  return `/api/owner/schedules/${id}`;
}
function scheduleRecord(value: unknown): AvailabilitySchedule {
  const data = object(value);
  exact(data, ["id", "name", "schedule"]);
  if (
    !isScheduleId(data.id) ||
    typeof data.name !== "string" ||
    !data.name.trim() ||
    data.name !== data.name.trim() ||
    data.name.length > 100
  )
    throw new Error();
  const raw = object(data.schedule);
  exact(raw, ["timeZone", "rules", "overrides"]);
  const schedule = parseSettings({ ...defaultSettings, schedule: raw }).schedule;
  if (!Array.isArray(raw.rules)) throw new Error();
  for (const rule of raw.rules) exact(object(rule), ["weekday", "startMinute", "endMinute"]);
  if (raw.overrides !== undefined) {
    if (!Array.isArray(raw.overrides)) throw new Error();
    for (const override of raw.overrides) {
      const row = object(override);
      exact(row, ["date", "ranges"]);
      if (!Array.isArray(row.ranges)) throw new Error();
      for (const range of row.ranges) exact(object(range), ["startMinute", "endMinute"]);
    }
  }
  return { id: data.id, name: data.name, schedule };
}
function scheduleCatalog(value: unknown): ScheduleCatalog {
  const data = object(value);
  exact(data, ["defaultScheduleId", "schedules"]);
  if (!isScheduleId(data.defaultScheduleId) || !Array.isArray(data.schedules)) throw new Error();
  const schedules = data.schedules.map(scheduleRecord);
  if (
    new Set(schedules.map(({ id }) => id)).size !== schedules.length ||
    !schedules.some(({ id }) => id === data.defaultScheduleId)
  )
    throw new Error();
  return { defaultScheduleId: data.defaultScheduleId, schedules };
}

function eventPath(id: string): string {
  if (!isEventId(id)) throw new ErrorWithCode("invalid_event", 400);
  return `/api/events/${id}`;
}
function exact(data: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(data).some((key) => !keys.includes(key))) throw new Error();
}
function ownerEvent(value: unknown): OwnerEvent {
  const data = object(value);
  exact(data, ["id", "event", "lifecycle"]);
  if (!isEventId(data.id) || (data.lifecycle !== "listed" && data.lifecycle !== "hidden")) throw new Error();
  const event = object(data.event);
  exact(event, [
    ...Object.keys(defaultSettings.event),
    "disableCancelling",
    "disableRescheduling",
    "bookingWindowDays",
    "location",
  ]);
  return {
    id: data.id,
    event: parseSettings({ ...defaultSettings, event }).event,
    lifecycle: data.lifecycle,
  };
}
function saved(value: unknown): void {
  const data = object(value);
  if (Object.keys(data).length !== 1 || data.saved !== true) throw new Error();
}

class ErrorWithCode extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryable = status === 0 || status < 400 || status === 408 || status === 429 || status >= 500;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error();
  return value;
}
function interval(value: unknown): Interval {
  const data = object(value);
  if (
    typeof data.start !== "number" ||
    !Number.isSafeInteger(data.start) ||
    typeof data.end !== "number" ||
    !Number.isSafeInteger(data.end) ||
    data.start < Date.UTC(2000, 0, 1) ||
    data.end > Date.UTC(2100, 0, 1) ||
    data.end <= data.start
  )
    throw new Error();
  return { start: data.start, end: data.end };
}
function booking(value: unknown): BookingView {
  const data = object(value);
  const id = text(data.id);
  if (
    !/^[0-9a-f]{64}$/.test(id) ||
    typeof data.version !== "number" ||
    !Number.isSafeInteger(data.version) ||
    data.version < 0 ||
    !isValidTimeZone(text(data.timeZone))
  )
    throw new Error();
  const status = data.status;
  if (
    status !== "pending" &&
    status !== "confirmed" &&
    status !== "rescheduling" &&
    status !== "cancelling" &&
    status !== "cancelled" &&
    status !== "attention"
  )
    throw new Error();
  const result: BookingView = {
    id,
    status,
    version: data.version,
    ...interval(data),
    name: text(data.name),
    email: text(data.email),
    title: text(data.title),
    timeZone: text(data.timeZone),
  };
  for (const key of ["disableCancelling", "disableRescheduling"] as const) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== "boolean") throw new Error();
      result[key] = data[key];
    }
  }
  if (data.pendingAction !== undefined) {
    if (
      data.pendingAction !== "create" &&
      data.pendingAction !== "reschedule" &&
      data.pendingAction !== "cancel"
    )
      throw new Error();
    result.pendingAction = data.pendingAction;
  }
  if (data.error !== undefined) result.error = text(data.error);
  const pending = status !== "confirmed" && status !== "cancelled";
  if (
    pending !== (result.pendingAction !== undefined) ||
    (status === "attention") !== (result.error !== undefined)
  )
    throw new Error();
  if (
    (status === "pending" && result.pendingAction !== "create") ||
    (status === "rescheduling" && result.pendingAction !== "reschedule") ||
    (status === "cancelling" && result.pendingAction !== "cancel")
  )
    throw new Error();
  if (data.manageToken !== undefined) {
    const token = text(data.manageToken);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    result.manageToken = token;
  }
  if (Object.hasOwn(data, "cancellationReason")) {
    const reason = parseCancellationReason(data.cancellationReason);
    if (status !== "cancelled" || !reason || reason !== data.cancellationReason) throw new Error();
    result.cancellationReason = reason;
  }
  if (Object.hasOwn(data, "rescheduleReason")) {
    const reason = parseRescheduleReason(data.rescheduleReason);
    if (status !== "confirmed" || !reason || reason !== data.rescheduleReason) throw new Error();
    result.rescheduleReason = reason;
  }
  if (Object.hasOwn(data, "location")) {
    const location = text(data.location);
    if (status !== "confirmed" || !location.length || location.length > 1000 || location.trim() !== location)
      throw new Error();
    result.location = location;
  }
  return result;
}
function accessHeaders(access: BookingAccess): { Authorization: string } {
  if (!/^[0-9a-f]{64}$/.test(access.id) || !/^[A-Za-z0-9_-]{43}$/.test(access.token))
    throw new ErrorWithCode("invalid_access", 400);
  return { Authorization: `Bearer ${access.token}` };
}
function slots(value: unknown): Interval[] {
  const data = object(value);
  if (!Array.isArray(data.slots) || data.slots.length > MAX_QUERY_DAYS * 1440) throw new Error();
  return data.slots.map(interval);
}

class BookerClient {
  private readonly transport: Transport;
  constructor(transport: Transport = (path: string, init: RequestInit) => fetch(path, init)) {
    this.transport = transport;
  }
  private async request<T>(
    path: string,
    decode: (value: unknown) => T,
    init: RequestInit = {},
    expectedStatus?: number
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(path, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ErrorWithCode("network_error", 0);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    if (!response.ok) {
      const code = value && typeof value === "object" && "error" in value ? value.error : undefined;
      throw new ErrorWithCode(
        typeof code === "string" && /^[a-zA-Z_]{1,64}$/.test(code) ? code : "request_failed",
        response.status
      );
    }
    try {
      if (expectedStatus !== undefined && response.status !== expectedStatus) throw new Error();
      return decode(value);
    } catch {
      throw new ErrorWithCode("invalid_response", response.status);
    }
  }
  publicData(signal?: AbortSignal): Promise<PublicBooking> {
    return this.request(
      "/api/public",
      (value) => {
        const data = object(value);
        return { ...parseSettings(data), organizer: { name: text(object(data.organizer).name) } };
      },
      { signal }
    );
  }
  eventData(id: string, signal?: AbortSignal): Promise<PublicBooking & { id: string }> {
    return this.request(
      eventPath(id),
      (value) => {
        const data = object(value);
        exact(data, ["id", "event", "schedule", "organizer"]);
        if (data.id !== id || Object.hasOwn(object(data.event), "location")) throw new Error();
        return { ...parseSettings(data), id, organizer: { name: text(object(data.organizer).name) } };
      },
      { signal }
    );
  }
  ownerEvents(signal?: AbortSignal): Promise<OwnerEvent[]> {
    return this.request(
      "/api/owner/events",
      (value) => {
        const data = object(value);
        exact(data, ["events"]);
        if (!Array.isArray(data.events)) throw new Error();
        const events = data.events.map(ownerEvent);
        if (
          new Set(events.map((event) => event.id)).size !== events.length ||
          new Set(events.map((entry) => entry.event.slug)).size !== events.length
        )
          throw new Error();
        return events;
      },
      { signal }
    );
  }
  ownerSchedules(signal?: AbortSignal): Promise<ScheduleCatalog> {
    return this.request("/api/owner/schedules", scheduleCatalog, { signal }, 200);
  }
  ownerSchedule(id: string, signal?: AbortSignal): Promise<AvailabilitySchedule> {
    return this.request(
      schedulePath(id),
      (value) => {
        const result = scheduleRecord(value);
        if (result.id !== id) throw new Error();
        return result;
      },
      { signal },
      200
    );
  }
  ownerCreateSchedule(name: string, source?: string, signal?: AbortSignal): Promise<AvailabilitySchedule> {
    return this.request(
      source === undefined ? "/api/owner/schedules" : `${schedulePath(source)}/duplicate`,
      (value) => {
        const result = scheduleRecord(value);
        if (result.id === "legacy" || result.id === source || result.name !== name.trim()) throw new Error();
        return result;
      },
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal,
      },
      201
    );
  }
  ownerRenameSchedule(id: string, name: string, signal?: AbortSignal): Promise<void> {
    return this.request(
      schedulePath(id),
      saved,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal,
      },
      200
    );
  }
  ownerDefaultSchedule(id: string, signal?: AbortSignal): Promise<void> {
    return this.request(
      `${schedulePath(id)}/default`,
      saved,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal,
      },
      200
    );
  }
  ownerDeleteSchedule(id: string, signal?: AbortSignal): Promise<void> {
    return this.request(schedulePath(id), saved, { method: "DELETE", signal }, 200);
  }
  ownerAssignSchedule(id: string, scheduleId: string | null, signal?: AbortSignal): Promise<void> {
    eventPath(id);
    if (scheduleId !== null) schedulePath(scheduleId);
    return this.request(
      `/api/owner/events/${id}/schedule`,
      saved,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId }),
        signal,
      },
      200
    );
  }
  ownerWeeklySchedule(id: string, input: WeeklySchedule, signal?: AbortSignal): Promise<void> {
    return this.request(
      `${schedulePath(id)}/weekly`,
      saved,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      },
      200
    );
  }
  ownerScheduleOverrides(id: string, input: ScheduleOverrides, signal?: AbortSignal): Promise<void> {
    return this.request(
      `${schedulePath(id)}/overrides`,
      saved,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      },
      200
    );
  }
  ownerEvent(id: string, signal?: AbortSignal): Promise<OwnerEvent> {
    eventPath(id);
    return this.request(
      `/api/owner/events/${id}`,
      (value) => {
        const result = ownerEvent(value);
        if (result.id !== id) throw new Error();
        return result;
      },
      { signal }
    );
  }
  ownerCreateEvent(input: EventDetails): Promise<OwnerEvent> {
    return this.request(
      "/api/owner/events",
      (value) => {
        const result = ownerEvent(value);
        if (result.id === "default") throw new Error();
        const { title, slug, description, durationMinutes, location } = result.event;
        if (
          title !== input.title ||
          slug !== input.slug ||
          description !== input.description ||
          durationMinutes !== input.durationMinutes ||
          (location ?? "") !== (input.location ?? "")
        )
          throw new Error();
        return result;
      },
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
    );
  }
  ownerSaveEvent(id: string, input: EventDetails): Promise<void> {
    eventPath(id);
    return this.request(`/api/owner/events/${id}`, saved, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  ownerDuplicateEvent(id: string, input: Omit<EventDetails, "location">): Promise<OwnerEvent> {
    eventPath(id);
    const { title, slug, description, durationMinutes } = input;
    const details = { title, slug, description, durationMinutes };
    return this.request(
      `/api/owner/events/${id}/duplicate`,
      (value) => {
        const result = ownerEvent(value);
        if (result.id === id || result.id === "default") throw new Error();
        if (
          result.event.title !== title ||
          result.event.slug !== slug ||
          result.event.description !== description ||
          result.event.durationMinutes !== durationMinutes
        )
          throw new Error();
        return result;
      },
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(details) }
    );
  }
  ownerSetVisibility(id: string, hidden: boolean): Promise<void> {
    eventPath(id);
    return this.request(`/api/owner/events/${id}/visibility`, saved, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden }),
    });
  }
  ownerRemoveEvent(id: string): Promise<void> {
    eventPath(id);
    return this.request(`/api/owner/events/${id}`, saved, { method: "DELETE" });
  }
  ownerSaveRules(id: string, input: BookingRules): Promise<void> {
    eventPath(id);
    return this.request(`/api/owner/events/${id}/booking-rules`, saved, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  slots({
    from,
    to,
    timeZone,
    access,
    signal,
  }: {
    from: number;
    to: number;
    timeZone: string;
    access?: BookingAccess | EventAccess;
    signal?: AbortSignal;
  }): Promise<Interval[]> {
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      timeZone,
    });
    if (access && "kind" in access)
      return this.request(`${eventPath(access.id)}/slots?${query}`, slots, { signal });
    const headers = access ? accessHeaders(access) : undefined;
    if (access) query.set("bookingId", access.id);
    return this.request(`/api/slots?${query}`, slots, { headers, signal });
  }
  calendarSlots(
    access: CalendarAccess | undefined,
    options: { from: number; to: number; timeZone: string; signal?: AbortSignal }
  ): Promise<Interval[]> {
    if (access && "kind" in access && access.kind === "owner") return this.ownerSlots(access.id, options);
    return this.slots({ ...options, access });
  }
  create(input: CreateRequest, eventId?: string): Promise<BookingView & { manageToken: string }> {
    return this.request(
      eventId === undefined ? "/api/bookings" : `${eventPath(eventId)}/bookings`,
      (value) => {
        const result = booking(value);
        if (!result.manageToken) throw new Error();
        return { ...result, manageToken: result.manageToken };
      },
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
    );
  }
  view(access: BookingAccess): Promise<BookingView> {
    return this.request(
      `/api/bookings/${access.id}`,
      (value) => {
        const result = booking(value);
        if (result.id !== access.id) throw new Error();
        return result;
      },
      { headers: accessHeaders(access) }
    );
  }
  private ownerBooking(id: string, init: RequestInit = {}): Promise<BookingView> {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ErrorWithCode("invalid_access", 400);
    return this.request(
      `/api/owner/bookings/${id}`,
      (value) => {
        const result = booking(value);
        if (result.id !== id || result.manageToken !== undefined) throw new Error();
        return result;
      },
      init
    );
  }
  ownerView(id: string): Promise<BookingView> {
    return this.ownerBooking(id);
  }
  ownerSlots(
    id: string,
    { from, to, timeZone, signal }: { from: number; to: number; timeZone: string; signal?: AbortSignal }
  ): Promise<Interval[]> {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ErrorWithCode("invalid_access", 400);
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      timeZone,
    });
    return this.request(`/api/owner/bookings/${id}/slots?${query}`, slots, { signal });
  }
  ownerReschedule(id: string, input: Extract<ChangeRequest, { action: "reschedule" }>): Promise<BookingView> {
    return this.ownerBooking(id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  ownerCancel(id: string, input: Extract<ChangeRequest, { action: "cancel" }>): Promise<BookingView> {
    return this.ownerBooking(id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  change(access: BookingAccess, input: ChangeRequest): Promise<BookingView> {
    return this.request(`/api/bookings/${access.id}`, booking, {
      method: "POST",
      headers: { ...accessHeaders(access), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  retry(access: BookingAccess): Promise<BookingView> {
    return this.request(`/api/bookings/${access.id}/retry`, booking, {
      method: "POST",
      headers: { ...accessHeaders(access), "Content-Type": "application/json" },
      body: "{}",
    });
  }
}

export {
  BookerClient,
  ErrorWithCode,
  type CreateRequest,
  type ChangeRequest,
  type BookingAccess,
  type PublicBooking,
  type EventAccess,
  type CalendarAccess,
};
