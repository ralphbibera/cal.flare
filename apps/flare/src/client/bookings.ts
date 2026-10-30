import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { parseRescheduleReason } from "../domain/reschedule-reason.ts";
import type { Interval } from "../domain/scheduling.ts";
import { isValidTimeZone, MAX_QUERY_DAYS } from "../domain/scheduling.ts";
import type { Settings } from "../domain/settings.ts";
import { parseSettings } from "../domain/settings.ts";
import type { BookingView, parseChange, parseCreate } from "../server/booking-model.ts";

type Transport = (path: string, init: RequestInit) => Promise<Response>;
type CreateRequest = Omit<ReturnType<typeof parseCreate>, "action">;
type ChangeRequest = ReturnType<typeof parseChange>;
type BookingAccess = { id: string; token: string };
type PublicBooking = Settings & { organizer: { name: string } };

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
    access?: BookingAccess;
    signal?: AbortSignal;
  }): Promise<Interval[]> {
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      timeZone,
    });
    const headers = access ? accessHeaders(access) : undefined;
    if (access) query.set("bookingId", access.id);
    return this.request(`/api/slots?${query}`, slots, { headers, signal });
  }
  create(input: CreateRequest): Promise<BookingView & { manageToken: string }> {
    return this.request(
      "/api/bookings",
      (value) => {
        const result = booking(value);
        if (!result.manageToken) throw new Error();
        return { ...result, manageToken: result.manageToken };
      },
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
    );
  }
  view(access: BookingAccess): Promise<BookingView> {
    return this.request(`/api/bookings/${access.id}`, booking, { headers: accessHeaders(access) });
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
};
