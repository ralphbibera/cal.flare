import { isValidTimeZone } from "../domain/scheduling.ts";
import type { BookingAccess, CreateRequest } from "./bookings.ts";
import { ErrorWithCode } from "./bookings.ts";

type PendingCreate = { kind: "pending"; request: Readonly<CreateRequest> };
type CreationReceipt = { kind: "receipt"; requestKey: string; access: Readonly<BookingAccess> };
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
function decode(value: unknown): CreationState {
  const data = object(value);
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
    return {
      kind: "pending",
      request: Object.freeze({
        requestKey: key(request.requestKey),
        start: request.start,
        name: request.name,
        email: request.email,
        timeZone: request.timeZone,
      }),
    };
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
      requestKey: key(data.requestKey),
      access: Object.freeze({ id: access.id, token: access.token }),
    };
  }
  throw new Error();
}

class CreateAttempts {
  private readonly storage: Session;
  private readonly key: string;
  constructor({ storage, scope }: { storage: Session; scope: string }) {
    this.storage = storage;
    this.key = `calflare:create:v1:${encodeURIComponent(scope)}`;
  }
  read(): CreationState | null {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
    if (raw === null) return null;
    try {
      if (raw.length > 8192) throw new Error();
      return decode(JSON.parse(raw));
    } catch {
      throw new ErrorWithCode("invalid_saved_attempt", 400);
    }
  }
  private write(state: CreationState | null): void {
    try {
      if (state === null) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify(state));
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
  }
  begin(input: Omit<CreateRequest, "requestKey">): PendingCreate {
    const current = this.read();
    const body = { start: input.start, name: input.name, email: input.email, timeZone: input.timeZone };
    if (current?.kind === "receipt") throw new ErrorWithCode("booking_receipt_exists", 409);
    if (current?.kind === "pending") {
      const { requestKey: _, ...saved } = current.request;
      if (JSON.stringify(saved) !== JSON.stringify(body)) throw new ErrorWithCode("booking_in_progress", 409);
      return current;
    }
    let next: CreationState;
    try {
      next = decode({ kind: "pending", request: { requestKey: crypto.randomUUID(), ...body } });
    } catch {
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
      next = decode({ kind: "receipt", requestKey, access });
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
