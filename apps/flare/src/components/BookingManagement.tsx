import { type ReactElement, useEffect, useId, useState } from "react";
import { type AttendeeChangeStage, captureAttendeeChange } from "../client/attendee-change.ts";
import { BookerClient, type BookingAccess, ErrorWithCode } from "../client/bookings.ts";
import { ChangeAttempts } from "../client/change-attempt.ts";
import { managementLink } from "../client/management-access.ts";
import { BookingCalendar } from "./BookingCalendar.tsx";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { CalendarExport } from "./CalendarExport.tsx";
import { formatDuration } from "./format-duration.ts";
import { Label } from "./Label.tsx";
import { TextArea } from "./TextArea.tsx";

type Booking = Awaited<ReturnType<BookerClient["view"]>>;
type Labels = typeof bookingLabels;
type Stage = { kind: "restore" | "actions" | "calendar" | "blocked" } | AttendeeChangeStage;
type ManagementStatus = "loading" | "statusUnavailable" | "pending" | "confirmed" | "cancelled" | "attention";
type ReasonView =
  | { kind: "hidden" }
  | {
      kind: "editable";
      action: "cancel" | "reschedule";
      value: string;
      invalid: boolean;
    }
  | { kind: "frozen"; action: "cancel" | "reschedule"; value: string };
type ActionView =
  | { kind: "restore" | "blocked" | "calendar" }
  | { kind: "actions"; reschedule: boolean; cancel: boolean }
  | {
      kind: "change";
      back: "back" | "nevermind" | null;
      label: "reschedule" | "cancelEvent" | "retry";
      color: "primary" | "destructive";
    };
const client = new BookerClient();

function BookingManagement({
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
  const [cancellationDraft, setCancellationDraft] = useState("");
  const [rescheduleDraft, setRescheduleDraft] = useState("");
  const reasonId = useId();
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
    const captured = captureAttendeeChange({
      stage,
      version: booking.version,
      cancellationDraft,
      rescheduleDraft,
      store,
    });
    if (captured.kind === "invalid") {
      setStage(captured.stage);
      return;
    }
    if (captured.kind === "storage-blocked") {
      setStage({ kind: "blocked" });
      setError(labels.storageError);
      return;
    }
    const { request } = captured;
    setStage({ kind: "pending", request });
    setBusy(true);
    setError("");
    try {
      const result = await client.change(access, request);
      if (!store().acknowledge(request.requestKey)) throw new ErrorWithCode("stale_attempt", 409);
      onUpdated(result);
      if (request.action === "cancel") setCancellationDraft("");
      else setRescheduleDraft("");
      setStage({ kind: "actions" });
    } catch (failure) {
      rejectChange(request.requestKey, failure);
    } finally {
      setBusy(false);
    }
  }
  function rejectChange(requestKey: string, failure: unknown): void {
    try {
      if (store().reject(requestKey, failure)) {
        setStage({ kind: "actions" });
        setError(labels.slotConflict);
      } else setError(labels.bookingError);
    } catch {
      setStage({ kind: "blocked" });
      setError(labels.storageError);
    }
  }
  const status = managementStatus(stage, booking.status);
  const facts = bookingFacts({ booking, labels, timeFormat, stage, status });
  const proposed = proposedStart(stage);
  const reason = changeReason(stage, cancellationDraft, rescheduleDraft);
  function editReason(value: string): void {
    if (stage.kind === "move") {
      setRescheduleDraft(value);
      setStage({ kind: "move", start: stage.start });
    } else if (stage.kind === "cancel") {
      setCancellationDraft(value);
      setStage({ kind: "cancel" });
    }
  }
  return (
    <section className="bg-default border-subtle mx-auto w-full max-w-xl space-y-6 rounded-lg border px-8 pb-4 pt-5 sm:py-8">
      <ManagementHeading status={status} labels={labels} />
      {facts}
      {status === "confirmed" && stage.kind === "actions" && !busy && !error && (
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
      <ChangeReason reason={reason} reasonId={reasonId} labels={labels} onChange={editReason} />
      {error && <p role="alert">{error}</p>}
      <ManagementActions
        view={actionView(stage, booking, error)}
        labels={labels}
        busy={busy}
        onNavigate={(kind: "actions" | "calendar" | "cancel"): void => setStage({ kind })}
        onRefresh={refresh}
        onChange={change}
        onRestore={restore}
        onCopy={copyLink}
      />
      {copy === "copied" && <p role="status">{labels.copied}</p>}
      {copy === "failed" && <p role="alert">{labels.copyError}</p>}
      <p className="text-subtle text-sm">{labels.linkAccess}</p>
    </section>
  );
}

function managementStatus(stage: Stage, status: Booking["status"]): ManagementStatus {
  if (stage.kind === "restore") return "loading";
  if (stage.kind === "blocked") return "statusUnavailable";
  if (stage.kind === "pending") return "pending";
  if (status === "confirmed" || status === "cancelled" || status === "attention") return status;
  return "pending";
}

function proposedStart(stage: Stage): number | undefined {
  if (stage.kind === "move") return stage.start;
  if (stage.kind === "pending" && stage.request.action === "reschedule") return stage.request.start;
  return undefined;
}

function changeReason(stage: Stage, cancellationDraft: string, rescheduleDraft: string): ReasonView {
  if (stage.kind === "pending") {
    const { request } = stage;
    return {
      kind: "frozen",
      action: request.action,
      value: (request.action === "reschedule" ? request.rescheduleReason : request.cancellationReason) ?? "",
    };
  }
  if (stage.kind === "move")
    return { kind: "editable", action: "reschedule", value: rescheduleDraft, invalid: !!stage.invalid };
  if (stage.kind === "cancel")
    return { kind: "editable", action: "cancel", value: cancellationDraft, invalid: !!stage.invalid };
  return { kind: "hidden" };
}

function actionView(stage: Stage, booking: Booking, error: string): ActionView {
  switch (stage.kind) {
    case "actions":
      return {
        kind: "actions",
        reschedule: booking.status === "confirmed" && !error && !booking.disableRescheduling,
        cancel: booking.status === "confirmed" && !error && !booking.disableCancelling,
      };
    case "move":
      return { kind: "change", back: "back", label: "reschedule", color: "primary" };
    case "cancel":
      return { kind: "change", back: "nevermind", label: "cancelEvent", color: "destructive" };
    case "pending":
      return { kind: "change", back: null, label: "retry", color: "primary" };
    default:
      return { kind: stage.kind };
  }
}

function ManagementHeading({ status, labels }: { status: ManagementStatus; labels: Labels }): ReactElement {
  return (
    <>
      {status === "confirmed" && (
        <div className="bg-cal-success mx-auto flex h-12 w-12 items-center justify-center rounded-full">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-green-600 dark:text-green-400"
            aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
      )}
      <h1 className="text-emphasis text-center text-2xl font-semibold leading-6" aria-live="polite">
        {labels[status]}
      </h1>
    </>
  );
}

function bookingFacts({
  booking,
  labels,
  timeFormat,
  stage,
  status,
}: {
  booking: Booking;
  labels: Labels;
  timeFormat: "h:mma" | "HH:mm";
  stage: Stage;
  status: ManagementStatus;
}): ReactElement {
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
  return (
    <dl className="border-subtle grid grid-cols-3 gap-x-4 gap-y-6 border-t pt-8 text-base leading-6 sm:gap-x-0">
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
          <time dateTime={new Date(booking.end).toISOString()}>{time.format(booking.end).toLowerCase()}</time>
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
      {stage.kind === "actions" && status === "confirmed" && booking.location && (
        <>
          <dt className="font-medium">{labels.where}</dt>
          <dd className="col-span-2 min-w-0 whitespace-pre-wrap break-words">{booking.location}</dd>
        </>
      )}
      {stage.kind === "actions" && booking.status === "cancelled" && booking.cancellationReason && (
        <>
          <dt className="font-medium">{labels.reason}</dt>
          <dd className="col-span-2 min-w-0 whitespace-pre-wrap break-words">{booking.cancellationReason}</dd>
        </>
      )}
      {stage.kind === "actions" && status === "confirmed" && booking.rescheduleReason && (
        <>
          <dt className="font-medium">{labels.rescheduleReasonDisplay}</dt>
          <dd className="col-span-2 min-w-0 whitespace-pre-wrap break-words">{booking.rescheduleReason}</dd>
        </>
      )}
    </dl>
  );
}

function ChangeReason({
  reason,
  reasonId,
  labels,
  onChange,
}: {
  reason: ReasonView;
  reasonId: string;
  labels: Labels;
  onChange: (value: string) => void;
}): ReactElement | null {
  if (reason.kind === "hidden") return null;
  const moving = reason.action === "reschedule";
  const invalid = reason.kind === "editable" && reason.invalid;
  return (
    <div>
      <Label htmlFor={reasonId}>{moving ? labels.rescheduleReason : labels.cancellationReason}</Label>
      <TextArea
        id={reasonId}
        rows={3}
        placeholder={moving ? labels.rescheduleReasonPlaceholder : labels.cancellationReasonPlaceholder}
        readOnly={reason.kind === "frozen"}
        value={reason.value}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${reasonId}-error` : undefined}
        onChange={(event) => {
          if (reason.kind === "editable") onChange(event.target.value);
        }}
      />
      {invalid && (
        <p id={`${reasonId}-error`} role="alert" className="text-error text-sm">
          {labels.reasonLimit}
        </p>
      )}
    </div>
  );
}

function ManagementActions({
  view,
  labels,
  busy,
  onNavigate,
  onRefresh,
  onChange,
  onRestore,
  onCopy,
}: {
  view: ActionView;
  labels: Labels;
  busy: boolean;
  onNavigate: (kind: "actions" | "calendar" | "cancel") => void;
  onRefresh: () => Promise<void>;
  onChange: () => Promise<void>;
  onRestore: () => void;
  onCopy: () => Promise<void>;
}): ReactElement {
  return (
    <div className="flex flex-wrap gap-2">
      {view.kind === "actions" && (
        <>
          <Button color="secondary" loading={busy} onClick={() => void onRefresh()}>
            {labels.checkStatus}
          </Button>
          {view.reschedule && (
            <Button disabled={busy} onClick={() => onNavigate("calendar")}>
              {labels.reschedule}
            </Button>
          )}
          {view.cancel && (
            <Button color="secondary" disabled={busy} onClick={() => onNavigate("cancel")}>
              {labels.cancelEvent}
            </Button>
          )}
        </>
      )}
      {view.kind === "calendar" && (
        <Button color="minimal" disabled={busy} onClick={() => onNavigate("actions")}>
          {labels.back}
        </Button>
      )}
      {view.kind === "change" && (
        <>
          {view.back && (
            <Button color="minimal" disabled={busy} onClick={() => onNavigate("actions")}>
              {labels[view.back]}
            </Button>
          )}
          <Button color={view.color} loading={busy} onClick={() => void onChange()}>
            {labels[view.label]}
          </Button>
        </>
      )}
      {view.kind === "blocked" && <Button onClick={onRestore}>{labels.retry}</Button>}
      <Button color="minimal" onClick={() => void onCopy()}>
        {labels.copyLink}
      </Button>
    </div>
  );
}

export { BookingManagement };
