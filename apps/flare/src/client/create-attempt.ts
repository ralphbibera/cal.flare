import { parseGuests } from "../domain/guests.ts";
import { isValidTimeZone } from "../domain/scheduling.ts";
import { DEFAULT_EVENT_ID, isEventId } from "../domain/settings.ts";
import type { BookingAccess, CreateRequest } from "./bookings.ts";
import { ErrorWithCode } from "./bookings.ts";

type PendingCreate = { kind: "pending"; eventId: string; request: Readonly<CreateRequest> };
type CreationReceipt = {
  kind: "receipt";
  eventId: string;
  requestKey: string;
  access: Readonly<BookingAccess>;
};
type CreationState = PendingCreate | CreationReceipt;
type Session = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return Object.fromEntries(Object.entries(value));
}
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    throw new Error();
  return value;
}
function normalizedNotes(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length > 1000) throw new ErrorWithCode("invalid_input", 400);
  return value.trim() || undefined;
}
function decode(value: unknown): CreationState {
  const data = object(value);
  if (!isEventId(data.eventId)) throw new Error();
  if (data.kind === "pending") {
    const request = object(data.request);
    if (
      typeof request.start !== "number" ||
      !Number.isSafeInteger(request.start) ||
      request.start < Date.UTC(2000, 0, 1) ||
      request.start > Date.UTC(2100, 0, 1) ||
      typeof request.name !== "string" ||
      !request.name.trim() ||
      request.name.length > 200 ||
      typeof request.email !== "string" ||
      request.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email) ||
      typeof request.timeZone !== "string" ||
      !isValidTimeZone(request.timeZone)
    )
      throw new Error();
    const notes = normalizedNotes(request.notes);
    const guests = parseGuests(request.guests);
    if (guests === null) throw new Error();
    const pending: PendingCreate = {
      kind: "pending",
      eventId: data.eventId,
      request: Object.freeze({
        requestKey: key(request.requestKey),
        start: request.start,
        name: request.name,
        email: request.email,
        timeZone: request.timeZone,
        ...(notes ? { notes } : {}),
        ...(guests ? { guests } : {}),
      }),
    };
    if (new TextEncoder().encode(JSON.stringify(pending.request)).byteLength > 32768)
      throw new ErrorWithCode("request_too_large", 413);
    return pending;
  }
  if (data.kind === "receipt") {
    const access = object(data.access);
    if (
      typeof access.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(access.id) ||
      typeof access.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(access.token)
    )
      throw new Error();
    return {
      kind: "receipt",
      eventId: data.eventId,
      requestKey: key(data.requestKey),
      access: Object.freeze({ id: access.id, token: access.token }),
    };
  }
  throw new Error();
}

class CreateAttempts {
  private readonly storage: Session;
  private readonly key: string;
  private readonly legacyKey: string | null;
  readonly eventId: string;
  constructor({ storage, scope, eventId }: { storage: Session; scope: string; eventId: string }) {
    if (!isEventId(eventId)) throw new ErrorWithCode("invalid_event", 400);
    this.storage = storage;
    this.eventId = eventId;
    this.key = `calflare:create:v2:${eventId}`;
    this.legacyKey = eventId === DEFAULT_EVENT_ID ? `calflare:create:v1:${encodeURIComponent(scope)}` : null;
  }
  read(): CreationState | null {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
    if (raw === null) return this.importLegacy();
    try {
      if (raw.length > 65536) throw new Error();
      const value = object(JSON.parse(raw));
      if (value.eventId !== this.eventId) throw new Error();
      if (value.kind === "empty" && Object.keys(value).length === 2) return null;
      const state = decode(value);
      if (JSON.stringify(state) !== raw) throw new Error();
      return state;
    } catch {
      throw new ErrorWithCode("invalid_saved_attempt", 400);
    }
  }
  private importLegacy(): CreationState | null {
    if (this.legacyKey === null) return null;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.legacyKey);
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
    if (raw === null) return null;
    let state: CreationState;
    try {
      if (raw.length > 65536) throw new Error();
      const value = object(JSON.parse(raw));
      if (Object.hasOwn(value, "eventId")) throw new Error();
      state = decode({ ...value, eventId: this.eventId });
      const { eventId: _, ...legacy } = state;
      if (JSON.stringify(legacy) !== raw) throw new Error();
    } catch {
      throw new ErrorWithCode("invalid_saved_attempt", 400);
    }
    this.write(state);
    try {
      if (this.storage.getItem(this.legacyKey) === raw) this.storage.removeItem(this.legacyKey);
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
    return state;
  }
  private write(state: CreationState | null): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(state ?? { kind: "empty", eventId: this.eventId }));
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
  }
  verify(pending: PendingCreate): void {
    const current = this.read();
    if (
      pending.eventId !== this.eventId ||
      current?.kind !== "pending" ||
      JSON.stringify(current) !== JSON.stringify(pending)
    )
      throw new ErrorWithCode("stale_attempt", 409);
  }
  begin(input: Omit<CreateRequest, "requestKey">): PendingCreate {
    const current = this.read();
    const notes = normalizedNotes(input.notes);
    const guests = parseGuests(input.guests);
    if (guests === null) throw new ErrorWithCode("invalid_input", 400);
    const body = {
      start: input.start,
      name: input.name,
      email: input.email,
      timeZone: input.timeZone,
      ...(notes ? { notes } : {}),
      ...(guests ? { guests } : {}),
    };
    if (current?.kind === "receipt") throw new ErrorWithCode("booking_receipt_exists", 409);
    if (current?.kind === "pending") {
      const { requestKey: _, ...saved } = current.request;
      if (JSON.stringify(saved) !== JSON.stringify(body)) throw new ErrorWithCode("booking_in_progress", 409);
      return current;
    }
    let next: CreationState;
    try {
      next = decode({
        kind: "pending",
        eventId: this.eventId,
        request: { requestKey: crypto.randomUUID(), ...body },
      });
    } catch (error) {
      if (error instanceof ErrorWithCode) throw error;
      throw new ErrorWithCode("invalid_input", 400);
    }
    if (next.kind !== "pending") throw new ErrorWithCode("invalid_input", 400);
    this.write(next);
    return next;
  }
  acknowledge(requestKey: string, access: BookingAccess): CreationReceipt {
    const current = this.read();
    if (
      current?.kind === "receipt" &&
      current.requestKey === requestKey &&
      current.access.id === access.id &&
      current.access.token === access.token
    )
      return current;
    if (current?.kind !== "pending" || current.request.requestKey !== requestKey)
      throw new ErrorWithCode("stale_attempt", 409);
    let next: CreationState;
    try {
      next = decode({ kind: "receipt", eventId: this.eventId, requestKey, access });
    } catch {
      throw new ErrorWithCode("invalid_receipt", 400);
    }
    if (next.kind !== "receipt") throw new ErrorWithCode("invalid_receipt", 400);
    this.write(next);
    return next;
  }
  reject(requestKey: string, error: unknown): boolean {
    if (
      !(error instanceof ErrorWithCode) ||
      error.status !== 409 ||
      !["conflict", "invalid_slot", "settings_changed"].includes(error.code)
    )
      return false;
    const current = this.read();
    if (current?.kind !== "pending" || current.request.requestKey !== requestKey) return false;
    this.write(null);
    return true;
  }
  clearReceipt(requestKey: string): boolean {
    const current = this.read();
    if (current?.kind !== "receipt" || current.requestKey !== requestKey) return false;
    this.write(null);
    return true;
  }
}

export { CreateAttempts, type PendingCreate, type CreationReceipt, type CreationState };
