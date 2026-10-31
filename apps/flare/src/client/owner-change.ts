import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { parseRescheduleReason } from "../domain/reschedule-reason.ts";
import type { BookingView } from "../server/booking-model.ts";
import type { ChangeRequest } from "./bookings.ts";
import type { ChangeAttempts } from "./change-attempt.ts";

type OwnerCommand =
  | { action: "cancel" }
  | { action: "reschedule"; start: number }
  | { request: Readonly<ChangeRequest> };
type CaptureResult =
  | { kind: "ready"; request: Readonly<ChangeRequest> }
  | { kind: "unavailable"; action: ChangeRequest["action"] }
  | { kind: "invalid-reason" }
  | { kind: "storage-blocked" };

const canCancel = (booking: BookingView): boolean =>
  booking.status === "confirmed" && !booking.disableCancelling && booking.end >= Date.now();
const canReschedule = (booking: BookingView): boolean =>
  booking.status === "confirmed" && !booking.disableRescheduling && booking.end >= Date.now();

function captureReplay(frozen: Readonly<ChangeRequest>, attempts: () => ChangeAttempts): CaptureResult {
  try {
    const request = attempts().read();
    if (
      !request ||
      (request.action === "cancel" && !request.cancellationReason) ||
      JSON.stringify(request) !== JSON.stringify(frozen)
    )
      return { kind: "storage-blocked" };
    return { kind: "ready", request };
  } catch {
    return { kind: "storage-blocked" };
  }
}

function captureOwnerChange({
  booking,
  command,
  draft,
  moveDraft,
  attempts,
}: {
  booking: BookingView;
  command: OwnerCommand;
  draft: string;
  moveDraft: string;
  attempts: () => ChangeAttempts;
}): CaptureResult {
  if ("request" in command) return captureReplay(command.request, attempts);
  if (!(command.action === "cancel" ? canCancel(booking) : canReschedule(booking)))
    return { kind: "unavailable", action: command.action };
  const normalized =
    command.action === "cancel" ? parseCancellationReason(draft) : parseRescheduleReason(moveDraft);
  if (normalized === null || (command.action === "cancel" && !normalized)) return { kind: "invalid-reason" };
  try {
    const request = attempts().begin(
      command.action === "reschedule"
        ? {
            action: "reschedule",
            version: booking.version,
            start: command.start,
            ...(normalized ? { rescheduleReason: normalized } : {}),
          }
        : {
            action: "cancel",
            version: booking.version,
            cancellationReason: normalized ?? undefined,
          }
    );
    if (request.action === "cancel" && !request.cancellationReason) return { kind: "storage-blocked" };
    return { kind: "ready", request };
  } catch {
    return { kind: "storage-blocked" };
  }
}

export { canCancel, canReschedule, captureOwnerChange };
