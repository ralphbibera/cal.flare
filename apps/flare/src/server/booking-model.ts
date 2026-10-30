import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { parseGuests } from "../domain/guests.ts";
import { parseRescheduleReason } from "../domain/reschedule-reason.ts";
import { isValidTimeZone } from "../domain/scheduling.ts";
import type { CalendarEvent, EventInput, GoogleCalendar } from "./google.ts";
import { ErrorWithCode, record } from "./http.ts";

export type Action = "create" | "reschedule" | "cancel";
export type OwnerBookingQuery = { filter: "all" | "upcoming" | "past" | "cancelled"; before: number | null };
export type OwnerBookingPage = { bookings: BookingView[]; older: number | null };

export function parseOwnerBookingQuery(params: URLSearchParams): OwnerBookingQuery {
  for (const key of params.keys()) {
    if (!["filter", "before"].includes(key) || params.getAll(key).length !== 1)
      throw new ErrorWithCode("invalid_booking_query");
  }
  const filter = params.get("filter") ?? "all";
  if (filter !== "all" && filter !== "upcoming" && filter !== "past" && filter !== "cancelled")
    throw new ErrorWithCode("invalid_booking_query");
  const cursor = params.get("before");
  if (cursor !== null && (!/^[1-9][0-9]{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
    throw new ErrorWithCode("invalid_booking_query");
  return { filter, before: cursor === null ? null : Number(cursor) };
}
export type BookingView = {
  id: string;
  status: "pending" | "confirmed" | "rescheduling" | "cancelling" | "cancelled" | "attention";
  version: number;
  start: number;
  end: number;
  name: string;
  email: string;
  timeZone: string;
  title: string;
  manageToken?: string;
  pendingAction?: Action;
  error?: string;
  disableCancelling?: boolean;
  disableRescheduling?: boolean;
  cancellationReason?: string;
  rescheduleReason?: string;
};
export type Booking = {
  id: string;
  version: number;
  state: "unconfirmed" | "active" | "cancelled";
  confirmed_json: string | null;
  initial_json: string;
  pending_id: string | null;
  etag: string | null;
};
export type Command = {
  id: string;
  request_key: string;
  booking_id: string;
  action: Action;
  payload: string;
  desired_json: string;
  settings_json: string;
  accepted_version: number;
  outcome: string;
  execution: "queued" | "sent" | "done";
  base_etag: string | null;
  nonce: string | null;
  lease_until: number;
  error: string | null;
  attempts: number;
};
export type Calendar = Pick<GoogleCalendar, "busy" | "insert" | "get" | "update" | "delete">;
export type BookingSnapshot = Omit<EventInput, "start" | "end"> & { start: number; end: number };
type ChangeRequest =
  | { action: "reschedule"; requestKey: string; version: number; start: number; rescheduleReason?: string }
  | { action: "cancel"; requestKey: string; version: number; cancellationReason?: string };

function text(value: unknown, max: number, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !value.trim())
    throw new ErrorWithCode("invalid_input");
  return value;
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ErrorWithCode("invalid_input");
  return value;
}
export function timestamp(value: unknown): number {
  return integer(value, Date.UTC(2000, 0, 1), Date.UTC(2100, 0, 1));
}
function key(value: unknown): string {
  const result = text(value, 128, 16);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new ErrorWithCode("invalid_request_key");
  return result;
}
function exact(data: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(data).some((field) => !keys.includes(field))) throw new ErrorWithCode("invalid_input");
}
function guest(data: Record<string, unknown>) {
  const name = text(data.name, 200),
    email = text(data.email, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErrorWithCode("invalid_input");
  return { name, email };
}
function zone(value: unknown): string {
  const result = text(value, 100);
  if (!isValidTimeZone(result)) throw new ErrorWithCode("invalid_input");
  return result;
}
export function parseCreate(input: unknown) {
  const data = record(input);
  exact(data, ["requestKey", "start", "name", "email", "timeZone", "notes", "guests"]);
  if (data.notes !== undefined && typeof data.notes !== "string") throw new ErrorWithCode("invalid_input");
  const notes = data.notes?.trim();
  if (notes && notes.length > 1000) throw new ErrorWithCode("invalid_input");
  const guests = parseGuests(data.guests);
  if (guests === null) throw new ErrorWithCode("invalid_input");
  return {
    action: "create" as const,
    requestKey: key(data.requestKey),
    start: timestamp(data.start),
    ...guest(data),
    timeZone: zone(data.timeZone),
    ...(notes ? { notes } : {}),
    ...(guests ? { guests } : {}),
  };
}
export function parseChange(input: unknown): ChangeRequest {
  const data = record(input);
  exact(data, ["action", "requestKey", "version", "start", "cancellationReason", "rescheduleReason"]);
  const action = data.action;
  if (action !== "reschedule" && action !== "cancel") throw new ErrorWithCode("invalid_input");
  const requestKey = key(data.requestKey),
    version = integer(data.version, 1);
  if (action === "reschedule") {
    if (Object.hasOwn(data, "cancellationReason")) throw new ErrorWithCode("invalid_input");
    const rescheduleReason = parseRescheduleReason(data.rescheduleReason);
    if (rescheduleReason === null) throw new ErrorWithCode("invalid_input");
    return {
      action,
      requestKey,
      version,
      start: timestamp(data.start),
      ...(rescheduleReason ? { rescheduleReason } : {}),
    };
  }
  if (Object.hasOwn(data, "rescheduleReason")) throw new ErrorWithCode("invalid_input");
  if (data.start !== undefined) throw new ErrorWithCode("invalid_input");
  const cancellationReason = parseCancellationReason(data.cancellationReason);
  if (cancellationReason === null) throw new ErrorWithCode("invalid_input");
  return { action, requestKey, version, ...(cancellationReason ? { cancellationReason } : {}) };
}
export function snapshot(json: string): BookingSnapshot {
  const data = record(JSON.parse(json));
  const guests = parseGuests(data.guests);
  if (guests === null) throw new ErrorWithCode("invalid_input");
  const start = timestamp(data.start),
    end = timestamp(data.end);
  if (end <= start || typeof data.description !== "string") throw new ErrorWithCode("invalid_input");
  const privateMetadata = Object.fromEntries(
    Object.entries(record(data.privateMetadata)).map(([key, value]) => [key, text(value, 1024)])
  );
  return {
    id: text(data.id, 1024),
    start,
    end,
    timeZone: zone(data.timeZone),
    title: text(data.title, 100),
    description: data.description,
    attendee: guest(record(data.attendee)),
    privateMetadata,
    ...(guests ? { guests } : {}),
  };
}
export function matches(event: CalendarEvent, desired: BookingSnapshot): boolean {
  const expected = new Set(
    [desired.attendee.email, ...(desired.guests ?? [])].map((email) => email.toLowerCase())
  );
  const actual = new Set(event.attendees.map((attendee) => attendee.email.toLowerCase()));
  const owner = event.calendarOwnerEmail?.toLowerCase();
  return (
    !event.attendeesOmitted &&
    event.attendees.every((attendee) => !attendee.additionalGuests) &&
    [...expected].every((email) => actual.has(email)) &&
    [...actual].every((email) => expected.has(email) || email === owner) &&
    event.id === desired.id &&
    event.status !== "cancelled" &&
    "dateTime" in event.start &&
    Date.parse(event.start.dateTime) === desired.start &&
    "dateTime" in event.end &&
    Date.parse(event.end.dateTime) === desired.end &&
    event.summary === desired.title &&
    (event.description ?? "") === desired.description &&
    event.attendees.some(
      (guest) =>
        guest.email.toLowerCase() === desired.attendee.email.toLowerCase() &&
        guest.displayName === desired.attendee.name
    ) &&
    Object.entries(desired.privateMetadata).every(
      ([key, value]) => event.extendedProperties.private[key] === value
    )
  );
}
