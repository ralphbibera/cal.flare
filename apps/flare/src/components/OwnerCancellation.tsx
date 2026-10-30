import { useEffect, useId, useRef, useState } from "react";
import common from "../../../../packages/i18n/locales/en/common.json";
import { BookerClient, type ChangeRequest, ErrorWithCode } from "../client/bookings.ts";
import { ChangeAttempts } from "../client/change-attempt.ts";
import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import type { BookingView } from "../server/booking-model.ts";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { Label } from "./Label.tsx";
import { OwnerBookingRecovery } from "./OwnerBookingRecovery.tsx";
import { TextArea } from "./TextArea.tsx";

type Cancellation = Extract<ChangeRequest, { action: "cancel" }>;
type Stage =
  | { kind: "restore" | "actions" | "confirm" | "blocked" | "refreshing" | "refreshFailed" | "unavailable" }
  | { kind: "pending"; request: Readonly<Cancellation> };
const status: Record<BookingView["status"], string> = {
  pending: common.pending,
  confirmed: common.flare_booking_status_confirmed,
  rescheduling: common.flare_booking_status_rescheduling,
  cancelling: common.flare_booking_status_cancelling,
  cancelled: common.cancelled,
  attention: common.flare_booking_status_attention,
};
const canCancel = (booking: BookingView): boolean =>
  booking.status === "confirmed" && !booking.disableCancelling && booking.end >= Date.now();
export function OwnerCancellation({
  booking: initialBooking,
  initialRange,
  labels,
}: {
  booking: BookingView;
  initialRange: string;
  labels: typeof bookingLabels;
}) {
  const [booking, setBooking] = useState(initialBooking);
  const [stage, setStage] = useState<Stage>({ kind: "restore" });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reason = useRef<HTMLTextAreaElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  const store = () =>
    new ChangeAttempts({
      bookingId: booking.id,
      storage: {
        getItem: (key) => sessionStorage.getItem(`calflare:owner:${key}`),
        setItem: (key, value) => sessionStorage.setItem(`calflare:owner:${key}`, value),
        removeItem: (key) => sessionStorage.removeItem(`calflare:owner:${key}`),
      },
    });
  function restore() {
    try {
      const request = store().read();
      if (request && (request.action !== "cancel" || !request.cancellationReason)) throw new Error();
      setStage(request ? { kind: "pending", request } : { kind: "actions" });
      setError("");
    } catch {
      setStage({ kind: "blocked" });
      setError(labels.storageError);
    }
  }
  useEffect(restore, []);
  useEffect(() => {
    if (stage.kind === "confirm") reason.current?.focus();
  }, [stage.kind]);
  async function refresh() {
    setStage({ kind: "refreshing" });
    setBusy(true);
    setError("");
    try {
      const latest = await new BookerClient().ownerView(booking.id);
      setBooking(latest);
      setStage({ kind: canCancel(latest) ? "confirm" : "unavailable" });
      setError(common.event_has_been_updated);
    } catch {
      setStage({ kind: "refreshFailed" });
      setError(labels.statusUnavailable);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (busy || (stage.kind !== "confirm" && stage.kind !== "pending")) return;
    if (stage.kind === "confirm" && !canCancel(booking)) {
      setStage({ kind: "unavailable" });
      return;
    }
    const normalized = parseCancellationReason(draft);
    if (stage.kind === "confirm" && !normalized) {
      setError(`${common.invalid_input} ${labels.reasonLimit}`);
      reason.current?.focus();
      return;
    }
    let request: Readonly<Cancellation>;
    try {
      const saved =
        stage.kind === "pending"
          ? store().read()
          : store().begin({
              action: "cancel",
              version: booking.version,
              cancellationReason: normalized ?? undefined,
            });
      if (
        !saved ||
        saved.action !== "cancel" ||
        !saved.cancellationReason ||
        (stage.kind === "pending" && JSON.stringify(saved) !== JSON.stringify(stage.request))
      )
        throw new Error();
      request = saved;
    } catch {
      setStage({ kind: "blocked" });
      setError(labels.storageError);
      return;
    }
    setStage({ kind: "pending", request });
    setBusy(true);
    setError("");
    try {
      await new BookerClient().ownerCancel(booking.id, request);
      if (!store().acknowledge(request.requestKey)) throw new ErrorWithCode("stale_attempt", 409);
      window.location.reload();
    } catch (failure) {
      try {
        if (store().reject(request.requestKey, failure)) {
          setDraft(request.cancellationReason ?? "");
          await refresh();
        } else setError(labels.bookingError);
      } catch {
        setStage({ kind: "blocked" });
        setError(labels.storageError);
      }
    } finally {
      setBusy(false);
    }
  }
  const pending = stage.kind === "pending" ? stage.request : undefined;
  const range =
    stage.kind === "restore"
      ? initialRange
      : new Intl.DateTimeFormat("en", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: booking.timeZone,
        }).formatRange(booking.start, booking.end);
  return (
    <section className="space-y-4">
      <section aria-labelledby="owner-bookings-title" className="border-subtle border-t pt-6">
        <h2 id="owner-bookings-title" className="mb-2 font-semibold text-emphasis">
          {common.bookings}
        </h2>
        <p className="mb-4 text-sm text-subtle">
          {common.timezone}: {booking.timeZone}
        </p>
        <div className="break-words rounded-md border border-subtle p-4 text-sm">
          <h3 className="font-semibold text-emphasis">{booking.title}</h3>
          <p>{booking.name}</p>
          <p>{booking.email}</p>
          <time dateTime={new Date(booking.start).toISOString()}>{range}</time>
          <p>{status[booking.status]}</p>
          {booking.pendingAction && (
            <OwnerBookingRecovery
              id={booking.id}
              labels={{
                retry: common.flare_owner_retry_pending,
                failed: labels.bookingError,
                javascript: common.flare_owner_retry_javascript,
              }}
            />
          )}
        </div>
        {booking.cancellationReason && (
          <p className="whitespace-pre-wrap break-words">
            {common.cancellation_reason}: {booking.cancellationReason}
          </p>
        )}
        {booking.status === "confirmed" && !canCancel(booking) && (
          <p>{booking.end < Date.now() ? common.cannot_cancel_past_booking : common.cannot_cancel_booking}</p>
        )}
      </section>
      {stage.kind === "actions" && canCancel(booking) && (
        <Button ref={trigger} color="secondary" onClick={() => setStage({ kind: "confirm" })}>
          {labels.cancelEvent}
        </Button>
      )}
      {(["confirm", "refreshing", "refreshFailed", "unavailable"].includes(stage.kind) || pending) && (
        <>
          {(stage.kind === "confirm" || pending) && <p>{labels.cancelPrompt}</p>}
          <Label htmlFor={id}>{labels.cancellationReason} *</Label>
          <TextArea
            ref={reason}
            id={id}
            required
            rows={3}
            readOnly={!!pending}
            value={pending?.cancellationReason ?? draft}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            placeholder={labels.cancellationReasonPlaceholder}
            onChange={(event) => {
              setDraft(event.target.value);
              if (stage.kind === "confirm") setError("");
            }}
          />
          <div className="flex flex-wrap gap-2">
            {stage.kind === "confirm" && (
              <Button
                color="minimal"
                onClick={() => {
                  setStage({ kind: "actions" });
                  setError("");
                  requestAnimationFrame(() => trigger.current?.focus());
                }}>
                {labels.nevermind}
              </Button>
            )}
            {(stage.kind === "confirm" || pending) && (
              <Button color="destructive" loading={busy} onClick={() => void cancel()}>
                {pending ? labels.retry : labels.cancelEvent}
              </Button>
            )}
          </div>
        </>
      )}
      {error && (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      {stage.kind === "blocked" && <Button onClick={restore}>{labels.retry}</Button>}
      {(stage.kind === "refreshing" || stage.kind === "refreshFailed") && (
        <Button loading={busy} onClick={() => void refresh()}>
          {labels.retry}
        </Button>
      )}
      <noscript>{labels.javascriptRequired}</noscript>
    </section>
  );
}
