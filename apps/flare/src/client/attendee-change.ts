import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { parseRescheduleReason } from "../domain/reschedule-reason.ts";
import type { ChangeRequest } from "./bookings.ts";
import type { ChangeAttempts } from "./change-attempt.ts";

type AttendeeChangeStage =
  | { kind: "cancel"; invalid?: true }
  | { kind: "move"; start: number; invalid?: true }
  | { kind: "pending"; request: Readonly<ChangeRequest> };
type CaptureResult =
  | { kind: "ready"; request: Readonly<ChangeRequest> }
  | { kind: "invalid"; stage: Exclude<AttendeeChangeStage, { kind: "pending" }> & { invalid: true } }
  | { kind: "storage-blocked" };

function captureAttendeeChange({
  stage,
  version,
  cancellationDraft,
  rescheduleDraft,
  store,
}: {
  stage: AttendeeChangeStage;
  version: number;
  cancellationDraft: string;
  rescheduleDraft: string;
  store: () => ChangeAttempts;
}): CaptureResult {
  if (stage.kind === "pending") return { kind: "ready", request: stage.request };
  const cancellationReason = stage.kind === "cancel" ? parseCancellationReason(cancellationDraft) : undefined;
  if (cancellationReason === null) return { kind: "invalid", stage: { kind: "cancel", invalid: true } };
  const rescheduleReason = stage.kind === "move" ? parseRescheduleReason(rescheduleDraft) : undefined;
  if (rescheduleReason === null) return { kind: "invalid", stage: { ...stage, invalid: true } };
  try {
    const request = store().begin(
      stage.kind === "move"
        ? {
            action: "reschedule",
            version,
            start: stage.start,
            ...(rescheduleReason ? { rescheduleReason } : {}),
          }
        : {
            action: "cancel",
            version,
            ...(cancellationReason ? { cancellationReason } : {}),
          }
    );
    return { kind: "ready", request };
  } catch {
    return { kind: "storage-blocked" };
  }
}

export { captureAttendeeChange, type AttendeeChangeStage };
