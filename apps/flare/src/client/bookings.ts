import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { parseRescheduleReason } from "../domain/reschedule-reason.ts";
import type { Interval } from "../domain/scheduling.ts";
import { isValidTimeZone, MAX_QUERY_DAYS } from "../domain/scheduling.ts";
import type { BookingRules, EventDetails, OwnerEvent, Settings } from "../domain/settings.ts";
import { defaultSettings, isEventId, parseSettings } from "../domain/settings.ts";
import type { BookingView, parseChange, parseCreate } from "../server/booking-model.ts";

type Transport = (path: string, init: RequestInit) => Promise<Response>;
type CreateRequest = Omit<ReturnType<typeof parseCreate>, "action">;
type ChangeRequest = ReturnType<typeof parseChange>;
type BookingAccess = { id: string; token: string };
type PublicBooking = Settings & { organizer: { name: string } };
type EventAccess = { kind: "event"; id: string };
type CalendarAccess = BookingAccess | EventAccess | { kind: "owner"; id: string };

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
  private async request<T>(path: string, decode: (value: unknown) => T, init: RequestInit = {}): Promise<T> {
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
