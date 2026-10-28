import { useEffect, useState } from "react";
import { BookerClient, type BookingAccess, type ChangeRequest, ErrorWithCode } from "../client/bookings.ts";
import { ChangeAttempts } from "../client/change-attempt.ts";
import { BookingCalendar, type BookingCalendarProps } from "./BookingCalendar.tsx";
import { Button } from "./Button.tsx";

type Booking = Awaited<ReturnType<BookerClient["view"]>>;
type Labels = BookingCalendarProps["labels"] & {
  confirmed: string;
  cancelled: string;
  pending: string;
  attention: string;
  checkStatus: string;
  bookingError: string;
  storageError: string;
  slotConflict: string;
  back: string;
  reschedule: string;
  cancelEvent: string;
  cancelPrompt: string;
  confirm: string;
};
type Stage =
  | { kind: "restore" | "actions" | "calendar" | "cancel" | "blocked" }
  | { kind: "move"; start: number }
  | { kind: "pending"; request: Readonly<ChangeRequest> };
const client = new BookerClient();

export function BookingManagement({
  booking,
  access,
  labels,
  timeFormat,
  onUpdated,
}: {
  booking: Booking;
  access: BookingAccess;
  labels: Labels;
  timeFormat: "h:mma" | "HH:mm";
  onUpdated: (booking: Booking) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "restore" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const store = () => new ChangeAttempts({ storage: sessionStorage, bookingId: access.id });
  function restore() {
    try {
      const request = store().read();
      setStage(request ? { kind: "pending", request } : { kind: "actions" });
      setError("");
    } catch {
      setStage({ kind: "blocked" });
      setError(labels.storageError);
    }
  }
  useEffect(restore, [access.id]);
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onUpdated(
        await (booking.status === "confirmed" || booking.status === "cancelled"
          ? client.view(access)
          : client.retry(access))
      );
    } catch {
      setError(labels.bookingError);
    } finally {
      setBusy(false);
    }
  }
  async function change() {
    if (busy || (stage.kind !== "pending" && stage.kind !== "move" && stage.kind !== "cancel")) return;
    let request: Readonly<ChangeRequest>;
    try {
      request =
        stage.kind === "pending"
          ? stage.request
          : store().begin(
              stage.kind === "move"
                ? { action: "reschedule", version: booking.version, start: stage.start }
                : { action: "cancel", version: booking.version }
            );
    } catch {
      setStage({ kind: "blocked" });
      setError(labels.storageError);
      return;
    }
    setStage({ kind: "pending", request });
    setBusy(true);
    setError("");
    try {
      const result = await client.change(access, request);
      if (!store().acknowledge(request.requestKey)) throw new ErrorWithCode("stale_attempt", 409);
      onUpdated(result);
      setStage({ kind: "actions" });
    } catch (failure) {
      try {
        if (store().reject(request.requestKey, failure)) {
          setStage({ kind: "actions" });
          setError(labels.slotConflict);
        } else setError(labels.bookingError);
      } catch {
        setStage({ kind: "blocked" });
        setError(labels.storageError);
      }
    } finally {
      setBusy(false);
    }
  }
  const heading =
    stage.kind === "pending"
      ? labels.pending
      : booking.status === "confirmed"
        ? labels.confirmed
        : booking.status === "cancelled"
          ? labels.cancelled
          : booking.status === "attention"
            ? labels.attention
            : labels.pending;
  const proposed =
    stage.kind === "move"
      ? stage.start
      : stage.kind === "pending" && stage.request.action === "reschedule"
        ? stage.request.start
        : undefined;
  return (
    <div className="space-y-4">
      <h2 className="text-emphasis text-xl font-semibold" aria-live="polite">
        {heading}
      </h2>
      <p>{booking.title}</p>
      <p>{booking.name}</p>
      <p>{booking.email}</p>
      {proposed !== undefined && (
        <time dateTime={new Date(proposed).toISOString()}>
          {new Intl.DateTimeFormat("en-US", {
            dateStyle: "full",
            timeStyle: "short",
            timeZone: booking.timeZone,
            hour12: timeFormat === "h:mma",
          }).format(proposed)}
        </time>
      )}
      {stage.kind === "calendar" && (
        <div className="grid min-w-0 md:grid-cols-2">
          <BookingCalendar
            timeZone={booking.timeZone}
            timeFormat={timeFormat}
            locale="en-US"
            labels={labels}
            access={access}
            selectedTime={new Date(booking.start).toISOString()}
            onTimeSelect={(time) => setStage({ kind: "move", start: Date.parse(time) })}
          />
        </div>
      )}
      {stage.kind === "cancel" && <p>{labels.cancelPrompt}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {stage.kind === "actions" && (
          <>
            <Button color="secondary" loading={busy} onClick={() => void refresh()}>
              {labels.checkStatus}
            </Button>
            {booking.status === "confirmed" && !error && (
              <>
                <Button disabled={busy} onClick={() => setStage({ kind: "calendar" })}>
                  {labels.reschedule}
                </Button>
                <Button color="secondary" disabled={busy} onClick={() => setStage({ kind: "cancel" })}>
                  {labels.cancelEvent}
                </Button>
              </>
            )}
          </>
        )}
        {(stage.kind === "calendar" || stage.kind === "move" || stage.kind === "cancel") && (
          <Button color="minimal" disabled={busy} onClick={() => setStage({ kind: "actions" })}>
            {labels.back}
          </Button>
        )}
        {(stage.kind === "move" || stage.kind === "cancel" || stage.kind === "pending") && (
          <Button loading={busy} onClick={() => void change()}>
            {stage.kind === "pending"
              ? labels.retry
              : stage.kind === "move"
                ? labels.reschedule
                : labels.confirm}
          </Button>
        )}
        {stage.kind === "blocked" && <Button onClick={restore}>{labels.retry}</Button>}
      </div>
    </div>
  );
}
