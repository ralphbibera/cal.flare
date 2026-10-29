import { useEffect, useState } from "react";
import { BookerClient, type BookingAccess, type ChangeRequest, ErrorWithCode } from "../client/bookings.ts";
import { ChangeAttempts } from "../client/change-attempt.ts";
import { managementLink } from "../client/management-access.ts";
import { BookingCalendar } from "./BookingCalendar.tsx";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { CalendarExport } from "./CalendarExport.tsx";
import { formatDuration } from "./format-duration.ts";
import { Icon } from "./Icon.tsx";

type Booking = Awaited<ReturnType<BookerClient["view"]>>;
type Labels = typeof bookingLabels;
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
  const [copy, setCopy] = useState<"ready" | "copied" | "failed">("ready");
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(managementLink(access, location.origin));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }
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
  const confirmed =
    booking.status === "confirmed" &&
    stage.kind !== "restore" &&
    stage.kind !== "blocked" &&
    stage.kind !== "pending";
  const heading =
    stage.kind === "restore"
      ? labels.loading
      : stage.kind === "blocked"
        ? labels.statusUnavailable
        : stage.kind === "pending"
          ? labels.pending
          : confirmed
            ? labels.confirmed
            : booking.status === "cancelled"
              ? labels.cancelled
              : booking.status === "attention"
                ? labels.attention
                : labels.pending;
  const date = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: booking.timeZone });
  const time = new Intl.DateTimeFormat("en-US", {
    timeStyle: "short",
    timeZone: booking.timeZone,
    hour12: timeFormat === "h:mma",
  });
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: booking.timeZone,
    timeZoneName: "long",
  })
    .formatToParts(booking.start)
    .find((part) => part.type === "timeZoneName")?.value;
  const duration = formatDuration((booking.end - booking.start) / 60_000, (count, unit) =>
    labels.duration[unit][count === 1 ? "one" : "other"].replaceAll("{{count}}", String(count))
  );
  const proposed =
    stage.kind === "move"
      ? stage.start
      : stage.kind === "pending" && stage.request.action === "reschedule"
        ? stage.request.start
        : undefined;
  return (
    <section className="bg-default border-subtle mx-auto w-full max-w-xl space-y-6 rounded-lg border p-8">
      {confirmed && (
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <Icon name="check" size={20} className="text-green-600" />
        </div>
      )}
      <h1 className="text-emphasis text-center text-2xl font-semibold leading-6" aria-live="polite">
        {heading}
      </h1>
      <dl className="border-subtle grid grid-cols-3 gap-x-4 gap-y-6 border-t pt-8 text-sm">
        <dt className="font-medium">{labels.what}</dt>
        <dd className="col-span-2 min-w-0 break-words">{booking.title}</dd>
        <dt className="font-medium">{labels.when}</dt>
        <dd className="col-span-2 min-w-0 space-y-1 break-words">
          <p>{date.formatRange(booking.start, booking.end)}</p>
          <p>
            <time dateTime={new Date(booking.start).toISOString()}>
              {time.format(booking.start).toLowerCase()}
            </time>
            {" – "}
            <time dateTime={new Date(booking.end).toISOString()}>
              {time.format(booking.end).toLowerCase()}
            </time>
          </p>
          <p>{zone}</p>
          <p>{booking.timeZone}</p>
          <p>{duration}</p>
        </dd>
        <dt className="font-medium">{labels.who}</dt>
        <dd className="col-span-2 min-w-0 break-words">
          <p>{booking.name}</p>
          <p>{booking.email}</p>
        </dd>
      </dl>
      {confirmed && stage.kind === "actions" && !busy && !error && (
        <CalendarExport booking={booking} labels={labels} />
      )}
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
                {!booking.disableRescheduling && (
                  <Button disabled={busy} onClick={() => setStage({ kind: "calendar" })}>
                    {labels.reschedule}
                  </Button>
                )}
                {!booking.disableCancelling && (
                  <Button color="secondary" disabled={busy} onClick={() => setStage({ kind: "cancel" })}>
                    {labels.cancelEvent}
                  </Button>
                )}
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
        <Button color="minimal" onClick={() => void copyLink()}>
          {labels.copyLink}
        </Button>
      </div>
      {copy === "copied" && <p role="status">{labels.copied}</p>}
      {copy === "failed" && <p role="alert">{labels.copyError}</p>}
      <p className="text-subtle text-sm">{labels.linkAccess}</p>
    </section>
  );
}
