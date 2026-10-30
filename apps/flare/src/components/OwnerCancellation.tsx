import { useEffect, useId, useRef, useState } from "react";
import common from "../../../../packages/i18n/locales/en/common.json";
import { BookerClient, type ChangeRequest, ErrorWithCode } from "../client/bookings.ts";
import { ChangeAttempts } from "../client/change-attempt.ts";
import { parseCancellationReason } from "../domain/cancellation-reason.ts";
import { parseRescheduleReason } from "../domain/reschedule-reason.ts";
import type { BookingView } from "../server/booking-model.ts";
import { BookingCalendar, type CalendarCursor } from "./BookingCalendar.tsx";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { Label } from "./Label.tsx";
import { OwnerBookingRecovery } from "./OwnerBookingRecovery.tsx";
import { TextArea } from "./TextArea.tsx";

type Action = ChangeRequest["action"];
type Stage =
  | { kind: "restore" | "actions" | "select" | "blocked" }
  | { kind: "confirm"; action: "cancel" }
  | { kind: "confirm"; action: "reschedule"; start: number }
  | { kind: "refreshing" | "refreshFailed" | "unavailable"; action: Action }
  | { kind: "pending"; request: Readonly<ChangeRequest> };
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
const canReschedule = (booking: BookingView): boolean =>
  booking.status === "confirmed" && !booking.disableRescheduling && booking.end >= Date.now();
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
  const [moveDraft, setMoveDraft] = useState("");
  const [cursor, setCursor] = useState<CalendarCursor>(() => {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: initialBooking.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(initialBooking.start);
    return { month: date.slice(0, 7), date };
  });
  const [returnTime, setReturnTime] = useState<string>();
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
      if (request?.action === "cancel" && !request.cancellationReason) throw new Error();
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
  async function refresh(action: Action) {
    setStage({ kind: "refreshing", action });
    setBusy(true);
    setError("");
    try {
      const latest = await new BookerClient().ownerView(booking.id);
      setBooking(latest);
      setStage(
        !(action === "reschedule" ? canReschedule(latest) : canCancel(latest))
          ? { kind: "unavailable", action }
          : action === "reschedule"
            ? { kind: "select" }
            : { kind: "confirm", action }
      );
      setError(common.event_has_been_updated);
    } catch {
      setStage({ kind: "refreshFailed", action });
      setError(labels.statusUnavailable);
    } finally {
      setBusy(false);
    }
  }
  async function change() {
    if (busy || (stage.kind !== "confirm" && stage.kind !== "pending")) return;
    if (
      stage.kind === "confirm" &&
      !(stage.action === "cancel" ? canCancel(booking) : canReschedule(booking))
    ) {
      setStage({ kind: "unavailable", action: stage.action });
      return;
    }
    const action = stage.kind === "pending" ? stage.request.action : stage.action;
    const normalized =
      action === "cancel" ? parseCancellationReason(draft) : parseRescheduleReason(moveDraft);
    if (stage.kind === "confirm" && (normalized === null || (action === "cancel" && !normalized))) {
      setError(`${common.invalid_input} ${labels.reasonLimit}`);
      reason.current?.focus();
      return;
    }
    let request: Readonly<ChangeRequest>;
    try {
      const saved =
        stage.kind === "pending"
          ? store().read()
          : store().begin(
              stage.action === "reschedule"
                ? {
                    action: "reschedule",
                    version: booking.version,
                    start: stage.start,
                    ...(normalized ? { rescheduleReason: normalized } : {}),
                  }
                : {
                    action: "cancel",
                    version: booking.version,
                    cancellationReason: normalized ?? undefined,
                  }
            );
      if (
        !saved ||
        (saved.action === "cancel" && !saved.cancellationReason) ||
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
      const client = new BookerClient();
      if (request.action === "reschedule") await client.ownerReschedule(booking.id, request);
      else await client.ownerCancel(booking.id, request);
      if (!store().acknowledge(request.requestKey)) throw new ErrorWithCode("stale_attempt", 409);
      window.location.reload();
    } catch (failure) {
      try {
        if (store().reject(request.requestKey, failure)) {
          if (request.action === "reschedule") setMoveDraft(request.rescheduleReason ?? "");
          else setDraft(request.cancellationReason ?? "");
          await refresh(request.action);
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
  const moving = pending
    ? pending.action === "reschedule"
    : "action" in stage && stage.action === "reschedule";
  const proposedStart =
    pending?.action === "reschedule"
      ? pending.start
      : stage.kind === "confirm" && stage.action === "reschedule"
        ? stage.start
        : undefined;
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
          {stage.kind === "actions" && booking.status === "confirmed" && booking.location && (
            <dl className="min-w-0">
              <dt className="font-medium">{labels.where}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words">{booking.location}</dd>
            </dl>
          )}
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
        {booking.rescheduleReason && (
          <p className="whitespace-pre-wrap break-words">
            {labels.rescheduleReasonDisplay}: {booking.rescheduleReason}
          </p>
        )}
        {booking.status === "confirmed" && !canCancel(booking) && (
          <p>{booking.end < Date.now() ? common.cannot_cancel_past_booking : common.cannot_cancel_booking}</p>
        )}
      </section>
      {stage.kind === "actions" && (
        <div className="flex flex-wrap gap-2">
          {canReschedule(booking) && (
            <Button
              color="secondary"
              onClick={() => {
                setStage({ kind: "select" });
                setError("");
              }}>
              {labels.reschedule}
            </Button>
          )}
          {canCancel(booking) && (
            <Button
              ref={trigger}
              color="secondary"
              onClick={() => setStage({ kind: "confirm", action: "cancel" })}>
              {labels.cancelEvent}
            </Button>
          )}
        </div>
      )}
      {stage.kind === "select" && (
        <>
          <Button
            color="minimal"
            onClick={() => {
              setStage({ kind: "actions" });
              setError("");
            }}>
            {labels.back}
          </Button>
          <div className="grid min-w-0 min-[769px]:grid-cols-2">
            <BookingCalendar
              timeZone={booking.timeZone}
              timeFormat="h:mma"
              locale="en"
              labels={labels}
              access={{ kind: "owner", id: booking.id }}
              cursor={cursor}
              onCursorChange={setCursor}
              returnFocusTime={returnTime}
              onTimeSelect={(time) => {
                setReturnTime(time);
                setStage({ kind: "confirm", action: "reschedule", start: Date.parse(time) });
                setError("");
              }}
            />
          </div>
        </>
      )}
      {(["confirm", "refreshing", "refreshFailed", "unavailable"].includes(stage.kind) || pending) && (
        <>
          {proposedStart !== undefined && (
            <p className="break-words">
              {labels.selectedTime}:{" "}
              <span>
                {new Date(proposedStart).toISOString()} /{" "}
                {new Date(proposedStart + booking.end - booking.start).toISOString()} (UTC)
              </span>
            </p>
          )}
          {!moving && (stage.kind === "confirm" || pending) && <p>{labels.cancelPrompt}</p>}
          <Label htmlFor={id}>{moving ? labels.rescheduleReason : `${labels.cancellationReason} *`}</Label>
          <TextArea
            ref={reason}
            id={id}
            required={!moving}
            rows={3}
            readOnly={!!pending}
            value={
              pending
                ? pending.action === "reschedule"
                  ? (pending.rescheduleReason ?? "")
                  : (pending.cancellationReason ?? "")
                : moving
                  ? moveDraft
                  : draft
            }
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            placeholder={moving ? labels.rescheduleReasonPlaceholder : labels.cancellationReasonPlaceholder}
            onChange={(event) => {
              if (moving) setMoveDraft(event.target.value);
              else setDraft(event.target.value);
              if (stage.kind === "confirm") setError("");
            }}
          />
          <div className="flex flex-wrap gap-2">
            {stage.kind === "confirm" && (
              <Button
                color="minimal"
                onClick={() => {
                  setStage({ kind: moving ? "select" : "actions" });
                  setError("");
                  requestAnimationFrame(() => trigger.current?.focus());
                }}>
                {moving ? labels.back : labels.nevermind}
              </Button>
            )}
            {(stage.kind === "confirm" || pending) && (
              <Button color={moving ? "primary" : "destructive"} loading={busy} onClick={() => void change()}>
                {pending ? labels.retry : moving ? labels.confirm : labels.cancelEvent}
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
        <Button loading={busy} onClick={() => void refresh(stage.action)}>
          {labels.retry}
        </Button>
      )}
      <noscript>{labels.javascriptRequired}</noscript>
    </section>
  );
}
