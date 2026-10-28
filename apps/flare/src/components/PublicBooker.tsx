import { useEffect, useRef, useState } from "react";
import { BookerClient, ErrorWithCode, type PublicBooking } from "../client/bookings.ts";
import { CreateAttempts, type CreationReceipt, type PendingCreate } from "../client/create-attempt.ts";
import { BookingCalendar } from "./BookingCalendar.tsx";
import { BookingManagement } from "./BookingManagement.tsx";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { EventMetaBlock } from "./EventMetaBlock.tsx";
import { EventTitle } from "./EventTitle.tsx";
import { Input } from "./Input.tsx";

type PublicBookerProps = Pick<PublicBooking, "organizer" | "event"> & {
  labels: typeof bookingLabels;
};

type Booking = Awaited<ReturnType<BookerClient["view"]>>;
type Stage =
  | { kind: "loading" | "calendar" | "blocked" }
  | { kind: "form"; start: number }
  | PendingCreate
  | { kind: "receipt"; receipt: CreationReceipt; booking?: Booking };
const client = new BookerClient();
const attempts = () => new CreateAttempts({ storage: sessionStorage, scope: location.pathname });

export function PublicBooker({ organizer, event, labels }: PublicBookerProps) {
  const [timeZone, setTimeZone] = useState("UTC");
  const [zones, setZones] = useState(["UTC"]);
  const [format, setFormat] = useState<"h:mma" | "HH:mm">("h:mma");
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [draft, setDraft] = useState({ name: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  async function loadReceipt(receipt: CreationReceipt) {
    setStage((previous) =>
      previous.kind === "receipt" && previous.receipt === receipt ? previous : { kind: "receipt", receipt }
    );
    setBusy(true);
    setError("");
    try {
      const booking = await client.view(receipt.access);
      setTimeZone(booking.timeZone);
      setStage({ kind: "receipt", receipt, booking });
    } catch {
      setError(labels.bookingError);
    } finally {
      setBusy(false);
    }
  }
  function restore() {
    setError("");
    try {
      const saved = attempts().read();
      if (saved?.kind === "receipt") {
        void loadReceipt(saved);
        return;
      }
      if (saved?.kind === "pending") setTimeZone(saved.request.timeZone);
      setStage(saved ?? { kind: "calendar" });
    } catch {
      setStage({ kind: "blocked" });
      setError(labels.storageError);
    }
  }
  useEffect(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setZones([...new Set(["UTC", local, ...Intl.supportedValuesOf("timeZone")])]);
    setTimeZone(local);
    restore();
  }, []);
  useEffect(() => {
    if (stage.kind === "form") nameInput.current?.focus();
  }, [stage.kind]);
  const start =
    stage.kind === "form"
      ? stage.start
      : stage.kind === "pending"
        ? stage.request.start
        : stage.kind === "receipt"
          ? stage.booking?.start
          : undefined;
  const selected = start === undefined ? undefined : new Date(start).toISOString();
  async function submit() {
    if (busy || (stage.kind !== "form" && stage.kind !== "pending")) return;
    let pending: PendingCreate;
    try {
      pending =
        stage.kind === "pending" ? stage : attempts().begin({ start: stage.start, ...draft, timeZone });
    } catch (failure) {
      if (failure instanceof ErrorWithCode && failure.code === "invalid_input") setError(labels.invalidInput);
      else {
        setStage({ kind: "blocked" });
        setError(labels.storageError);
      }
      return;
    }
    setStage(pending);
    setBusy(true);
    setError("");
    try {
      const booking = await client.create(pending.request);
      const receipt = attempts().acknowledge(pending.request.requestKey, {
        id: booking.id,
        token: booking.manageToken,
      });
      setDraft({ name: "", email: "" });
      setStage({ kind: "receipt", receipt, booking });
    } catch (failure) {
      try {
        if (attempts().reject(pending.request.requestKey, failure)) {
          setStage({ kind: "form", start: pending.request.start });
          setDraft({ name: pending.request.name, email: pending.request.email });
          setError(labels.slotConflict);
        } else setError(labels.bookingError);
      } catch {
        setError(labels.storageError);
      }
    } finally {
      setBusy(false);
    }
  }
  const selectedLabel = selected
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone,
        hour12: format === "h:mma",
      }).format(new Date(selected))
    : undefined;
  return (
    <main className="main text-default my-20 flex min-h-full w-full flex-col items-center overflow-visible">
      <div
        data-testid="booker-container"
        className="bg-default border-subtle dark:bg-cal-muted grid w-full max-w-full items-start rounded-md border [--booker-main-width:480px] [--booker-meta-width:240px] [--booker-timeslots-width:240px] md:w-auto md:grid-cols-[var(--booker-meta-width)_minmax(0,var(--booker-main-width))_var(--booker-timeslots-width)] lg:[--booker-meta-width:280px] lg:[--booker-timeslots-width:280px] [&>[aria-busy]]:w-auto">
        <section className="relative z-10 p-6" data-testid="event-meta">
          <p className="text-subtle text-sm font-medium">{organizer.name}</p>
          <EventTitle className="my-2">{event.title}</EventTitle>
          {event.description && (
            <p className="mb-8 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words text-sm">
              {event.description}
            </p>
          )}
          <div className="space-y-4 text-sm font-medium">
            <EventMetaBlock icon="clock" className="items-center">
              {labels.minutes.replace("{{count}}", String(event.durationMinutes))}
            </EventMetaBlock>
            <EventMetaBlock icon="globe" contentClassName="min-w-0 flex-1">
              <label htmlFor="booker-time-zone" className="sr-only">
                {labels.timeZone}
              </label>
              <select
                id="booker-time-zone"
                className="bg-default w-full min-w-0 text-sm"
                value={timeZone}
                disabled={stage.kind !== "calendar"}
                onChange={(change) => {
                  setTimeZone(change.target.value);
                }}>
                {zones.map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </select>
            </EventMetaBlock>
            <div className="flex gap-1" role="group" aria-label={labels.timeFormat}>
              {(["h:mma", "HH:mm"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  color="secondary"
                  aria-pressed={format === value}
                  onClick={() => setFormat(value)}>
                  {value === "h:mma" ? labels.hour12 : labels.hour24}
                </Button>
              ))}
            </div>
            {selected && (
              <EventMetaBlock icon="calendar" role="status">
                {labels.selectedTime}
                <br />
                <time dateTime={selected}>{selectedLabel}</time>
              </EventMetaBlock>
            )}
          </div>
        </section>
        {stage.kind === "calendar" ? (
          <BookingCalendar
            locale="en-US"
            timeZone={timeZone}
            timeFormat={format}
            labels={labels}
            selectedTime={selected}
            onTimeSelect={(value) => {
              setError("");
              setStage({ kind: "form", start: Date.parse(value) });
            }}
          />
        ) : (
          <section className="border-subtle p-6 md:col-span-2 md:border-l">
            {stage.kind === "loading" && <p role="status">{labels.loading}</p>}
            {(stage.kind === "form" || stage.kind === "pending") && (
              <form
                className="flex h-full flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}>
                <label className="text-default block text-sm font-medium">
                  {labels.name}
                  <Input
                    ref={nameInput}
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={200}
                    pattern=".*\S.*"
                    readOnly={busy || stage.kind === "pending"}
                    value={stage.kind === "pending" ? stage.request.name : draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label className="text-default block text-sm font-medium">
                  {labels.email}
                  <Input
                    type="email"
                    name="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    required
                    maxLength={254}
                    readOnly={busy || stage.kind === "pending"}
                    value={stage.kind === "pending" ? stage.request.email : draft.email}
                    onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                  />
                </label>
                {stage.kind === "pending" && <p role="status">{labels.pending}</p>}
                {error && <p role="alert">{error}</p>}
                <div className="mt-auto flex justify-end space-x-2">
                  <Button
                    color="minimal"
                    disabled={busy || stage.kind === "pending"}
                    onClick={() => {
                      setError("");
                      setStage({ kind: "calendar" });
                    }}>
                    {labels.back}
                  </Button>
                  <Button type="submit" loading={busy}>
                    {stage.kind === "pending" ? labels.retry : labels.confirm}
                  </Button>
                </div>
              </form>
            )}
            {stage.kind === "receipt" &&
              (stage.booking ? (
                <BookingManagement
                  booking={stage.booking}
                  access={stage.receipt.access}
                  labels={labels}
                  timeFormat={format}
                  onUpdated={(booking) => setStage({ ...stage, booking })}
                />
              ) : (
                <div className="space-y-4">
                  <h2 className="text-emphasis text-xl font-semibold" aria-live="polite">
                    {busy ? labels.loading : labels.statusUnavailable}
                  </h2>
                  {error && <p role="alert">{error}</p>}
                  <Button color="secondary" loading={busy} onClick={() => void loadReceipt(stage.receipt)}>
                    {labels.checkStatus}
                  </Button>
                </div>
              ))}
            {stage.kind === "blocked" && (
              <>
                <p role="alert">{error}</p>
                <Button onClick={restore}>{labels.retry}</Button>
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
