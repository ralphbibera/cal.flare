import { useEffect, useRef, useState } from "react";
import avatar from "../../../web/public/avatar.svg?url";
import { BookerClient, ErrorWithCode, type PublicBooking } from "../client/bookings.ts";
import { CreateAttempts, type CreationReceipt, type PendingCreate } from "../client/create-attempt.ts";
import { BookingCalendar } from "./BookingCalendar.tsx";
import { BookingManagement } from "./BookingManagement.tsx";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { EventMetaBlock } from "./EventMetaBlock.tsx";
import { EventTitle } from "./EventTitle.tsx";
import { formatDuration } from "./format-duration.ts";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { ScrollableWithGradients } from "./ScrollableWithGradients.tsx";
import { TimeFormatToggle } from "./TimeFormatToggle.tsx";
import { TimezoneSelect, timezoneAliases } from "./TimezoneSelect.tsx";

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
const avatarClass =
  "bg-emphasis relative inline-flex aspect-square items-center justify-center border align-top w-6 h-6 min-w-6 min-h-6 rounded-full";

export function PublicBooker({ organizer, event, labels }: PublicBookerProps) {
  const [timeZone, setTimeZone] = useState("UTC");
  const [zones, setZones] = useState<{ label: string; timezone: string }[]>([]);
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
    setZones([
      ...[
        ...new Set([
          "GMT",
          local,
          ...Intl.supportedValuesOf("timeZone"),
          ...timezoneAliases.map((zone) => zone.timezone),
        ]),
      ]
        .filter((zone) => zone !== "UTC")
        .map((zone) => ({
          label: zone === "GMT" ? "UTC" : (zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone),
          timezone: zone,
        })),
      ...timezoneAliases,
    ]);
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
  const timeFormatToggle = <TimeFormatToggle value={format} onChange={setFormat} labels={labels} />;
  return (
    <div className="main text-default flex min-h-full w-full flex-col items-center overflow-visible min-[769px]:my-20">
      <div
        data-testid="booker-container"
        className="bg-default border-subtle dark:bg-cal-muted grid w-full max-w-full items-start [--booker-main-width:480px] [--booker-meta-width:240px] [--booker-timeslots-width:240px] min-[769px]:min-h-[450px] min-[769px]:w-[calc(var(--booker-meta-width)+var(--booker-main-width)+var(--booker-timeslots-width))] min-[769px]:rounded-md min-[769px]:border min-[769px]:grid-cols-[var(--booker-meta-width)_1fr_var(--booker-timeslots-width)] lg:[--booker-meta-width:280px] lg:[--booker-timeslots-width:280px]">
        <section className="relative z-10 p-6" data-testid="event-meta">
          <ul className="border-muted flex items-center">
            <li className="-mr-1 inline-block">
              <span className={`${avatarClass} border-subtle overflow-hidden`}>
                <img src={avatar} alt={organizer.name} className={`${avatarClass} border-default`} />
              </span>
            </li>
          </ul>
          <p className="text-subtle mt-2 text-sm font-semibold">{organizer.name}</p>
          <EventTitle className="my-2">{event.title}</EventTitle>
          {event.description && (
            <EventMetaBlock contentClassName="mb-8">
              <ScrollableWithGradients
                className="wrap-break-word scroll-bar max-h-[180px] max-w-full overflow-y-auto whitespace-pre-wrap break-words pr-4"
                ariaLabel={labels.description}>
                {event.description}
              </ScrollableWithGradients>
            </EventMetaBlock>
          )}
          <div className="space-y-4 text-sm font-medium">
            <EventMetaBlock icon="clock" className="items-center">
              {formatDuration(event.durationMinutes, (count, unit) =>
                labels.duration[unit][count === 1 ? "one" : "other"].replaceAll("{{count}}", String(count))
              )}
            </EventMetaBlock>
            <EventMetaBlock
              icon="globe"
              className="cursor-pointer [&_.current-timezone:before]:focus-within:opacity-100 [&_.current-timezone:before]:hover:opacity-100"
              contentClassName="relative max-w-[90%]">
              {stage.kind === "calendar" || stage.kind === "loading" ? (
                <span className="current-timezone before:bg-subtle min-w-32 -mt-[2px] flex h-6 max-w-full items-center justify-start before:absolute before:inset-0 before:bottom-[-3px] before:left-[-30px] before:top-[-3px] before:w-[calc(100%+35px)] before:rounded-md before:py-3 before:opacity-0 before:transition-opacity">
                  <TimezoneSelect
                    value={timeZone}
                    onChange={setTimeZone}
                    data={zones}
                    label={labels.timeZone}
                    disabled={stage.kind !== "calendar"}
                  />
                </span>
              ) : (
                timeZone
              )}
            </EventMetaBlock>
            {stage.kind !== "calendar" && timeFormatToggle}
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
            timeFormatToggle={timeFormatToggle}
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
                <div>
                  <Label htmlFor="booker-name">{labels.name}</Label>
                  <Input
                    ref={nameInput}
                    id="booker-name"
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={200}
                    pattern=".*\S.*"
                    readOnly={busy || stage.kind === "pending"}
                    value={stage.kind === "pending" ? stage.request.name : draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="booker-email">{labels.email}</Label>
                  <Input
                    id="booker-email"
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
                </div>
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
      <span className="mb-6 mt-auto hidden pt-6 min-[769px]:block" aria-hidden="true" />
    </div>
  );
}
