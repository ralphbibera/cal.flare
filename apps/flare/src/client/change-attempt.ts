import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { type ChangeRequest, ErrorWithCode } from "./bookings.ts";

type ChangeInput =
  | Omit<Extract<ChangeRequest, { action: "reschedule" }>, "requestKey">
  | Omit<Extract<ChangeRequest, { action: "cancel" }>, "requestKey">;
type Session = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function decode(value: unknown): Readonly<ChangeRequest> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  if (
    !("requestKey" in value) ||
    typeof value.requestKey !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.requestKey) ||
    !("version" in value) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !("action" in value)
  )
    throw new Error();
  const { requestKey, version } = value;
  if (value.action === "cancel" && !("start" in value)) {
    const cancellationReason = parseCancellationReason(
      "cancellationReason" in value ? value.cancellationReason : undefined
    );
    if (cancellationReason === null) throw new Error();
    return Object.freeze({
      action: "cancel",
      requestKey,
      version,
      ...(cancellationReason ? { cancellationReason } : {}),
    });
  }
  if (
    value.action !== "reschedule" ||
    "cancellationReason" in value ||
    !("start" in value) ||
    typeof value.start !== "number" ||
    !Number.isSafeInteger(value.start) ||
    value.start < Date.UTC(2000, 0, 1) ||
    value.start > Date.UTC(2100, 0, 1)
  )
    throw new Error();
  return Object.freeze({ action: "reschedule", requestKey, version, start: value.start });
}

class ChangeAttempts {
  private readonly storage: Session;
  private readonly key: string;
  constructor({ storage, bookingId }: { storage: Session; bookingId: string }) {
    if (!/^[0-9a-f]{64}$/.test(bookingId)) throw new ErrorWithCode("invalid_access", 400);
    this.storage = storage;
    this.key = `calflare:change:v1:${bookingId}`;
  }
  read(): Readonly<ChangeRequest> | null {
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
  begin(input: ChangeInput): Readonly<ChangeRequest> {
    const current = this.read();
    let next: Readonly<ChangeRequest>;
    try {
      next = decode({ ...input, requestKey: current?.requestKey ?? crypto.randomUUID() });
    } catch {
      throw new ErrorWithCode("invalid_input", 400);
    }
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(next))
        throw new ErrorWithCode("booking_in_progress", 409);
      return current;
    }
    try {
      this.storage.setItem(this.key, JSON.stringify(next));
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
    return next;
  }
  acknowledge(requestKey: string): boolean {
    const current = this.read();
    if (!current || current.requestKey !== requestKey) return false;
    try {
      this.storage.removeItem(this.key);
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
    return true;
  }
  reject(requestKey: string, error: unknown): boolean {
    if (
      !(error instanceof ErrorWithCode) ||
      error.status !== 409 ||
      !["conflict", "invalid_slot", "settings_changed", "stale", "busy", "invalid_state"].includes(error.code)
    )
      return false;
    return this.acknowledge(requestKey);
  }
}

export { ChangeAttempts, type ChangeInput };
