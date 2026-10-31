import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { Provider } from "@radix-ui/react-tooltip";
import dayjs from "dayjs";
import type { ComponentProps, Dispatch, ReactElement, ReactNode, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import avatar from "../../../web/public/avatar.svg?url";
import { BookerClient, ErrorWithCode, type PublicBooking } from "../client/bookings.ts";
import { CreateAttempts, type CreationReceipt, type PendingCreate } from "../client/create-attempt.ts";
import { parseGuests } from "../domain/guests.ts";
import type { CalendarCursor, CalendarView } from "./BookingCalendar.tsx";
import { BookingCalendar } from "./BookingCalendar.tsx";
import { BookingFormDialog } from "./BookingFormDialog.tsx";
import { BookingManagement } from "./BookingManagement.tsx";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { EventMetaBlock } from "./EventMetaBlock.tsx";
import { EventTitle } from "./EventTitle.tsx";
import { formatDuration } from "./format-duration.ts";
import type { GuestRow } from "./GuestFields.tsx";
import { GuestFields } from "./GuestFields.tsx";
import { Icon } from "./Icon.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { ScrollableWithGradients } from "./ScrollableWithGradients.tsx";
import { TextArea } from "./TextArea.tsx";
import { TimeFormatToggle } from "./TimeFormatToggle.tsx";
import { TimezoneSelect, timezoneAliases } from "./TimezoneSelect.tsx";
import { Tooltip } from "./Tooltip.tsx";

type PublicBookerProps = Pick<PublicBooking, "organizer" | "event"> & {
  eventId: string;
  labels: typeof bookingLabels;
};

type Booking = Awaited<ReturnType<BookerClient["view"]>>;
type BookingDraft = { name: string; email: string; notes: string; guests: GuestRow[] };
type PreparedCreate = { store: CreateAttempts; pending: PendingCreate };
type BookerLayout = "month_view" | "week_view" | "column_view";
const layouts = [
  { value: "month_view", label: "monthView", icon: "calendar" },
  { value: "week_view", label: "weekView", icon: "grid-3x3" },
  { value: "column_view", label: "columnView", icon: "columns-3" },
] as const;
type Stage =
  | { kind: "loading" | "calendar" | "blocked" }
  | { kind: "form"; start: number }
  | PendingCreate
  | { kind: "receipt"; receipt: CreationReceipt; booking?: Booking };
const client = new BookerClient();
const avatarClass =
  "bg-emphasis relative inline-flex aspect-square items-center justify-center border align-top w-6 h-6 min-w-6 min-h-6 rounded-full";

function PublicBooker(props: PublicBookerProps) {
  return <BookingSession key={props.eventId} {...props} />;
}

function BookingSession({ eventId, organizer, event, labels }: PublicBookerProps) {
  const attempts = () => new CreateAttempts({ storage: sessionStorage, scope: location.pathname, eventId });
  const operation = useRef(0);
  const submitting = useRef(false);
  useEffect(
    () => () => {
      operation.current++;
    },
    []
  );
  const [timeZone, setTimeZone] = useState("UTC");
  const [zones, setZones] = useState<{ label: string; timezone: string }[]>([]);
  const [format, setFormat] = useState<"h:mma" | "HH:mm">("h:mma");
  const [layout, setLayout] = useState<BookerLayout>("month_view");
  const [width, setWidth] = useState(0);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [draft, setDraft] = useState<BookingDraft>({ name: "", email: "", notes: "", guests: [] });
  const [guestInvalid, setGuestInvalid] = useState(false);
  const [cursor, setCursor] = useState<CalendarCursor>(() => ({
    month: dayjs().format("YYYY-MM"),
    date: null,
  }));
  const [returnFocusTime, setReturnFocusTime] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  async function loadReceipt(receipt: CreationReceipt) {
    const ticket = ++operation.current;
    setStage((previous) =>
      previous.kind === "receipt" && previous.receipt === receipt ? previous : { kind: "receipt", receipt }
    );
    setBusy(true);
    setError("");
    try {
      const saved = attempts().read();
      if (
        receipt.eventId !== eventId ||
        saved?.kind !== "receipt" ||
        JSON.stringify(saved) !== JSON.stringify(receipt)
      )
        throw new Error();
      const booking = await client.view(receipt.access);
      if (ticket !== operation.current) return;
      setTimeZone(booking.timeZone);
      setStage({ kind: "receipt", receipt, booking });
    } catch {
      if (ticket === operation.current) setError(labels.bookingError);
    } finally {
      if (ticket === operation.current) setBusy(false);
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
    const resize = () => setWidth(innerWidth);
    resize();
    window.addEventListener("resize", resize);
    const requested = new URLSearchParams(location.search).get("layout");
    if (requested === "column_view" || requested === "week_view") {
      setLayout(requested);
      setCursor((previous) => ({ ...previous, date: previous.date ?? dayjs().format("YYYY-MM-DD") }));
    }
    return () => window.removeEventListener("resize", resize);
  }, []);
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
  const start = selectedStart(stage);
  const selected = start === undefined ? undefined : new Date(start).toISOString();
  function back() {
    if (busy || stage.kind !== "form") return;
    setReturnFocusTime(selected);
    setError("");
    setGuestInvalid(false);
    setStage({ kind: "calendar" });
  }
  async function submit(): Promise<void> {
    if (submitting.current || busy || (stage.kind !== "form" && stage.kind !== "pending")) return;
    const prepared = prepareSubmission(stage);
    if (!prepared) return;
    const { store, pending } = prepared;
    submitting.current = true;
    const ticket = ++operation.current;
    setStage(pending);
    setBusy(true);
    setError("");
    try {
      const booking = await client.create(pending.request, pending.eventId);
      if (ticket !== operation.current) return;
      const receipt = store.acknowledge(pending.request.requestKey, {
        id: booking.id,
        token: booking.manageToken,
      });
      setDraft({ name: "", email: "", notes: "", guests: [] });
      setStage({ kind: "receipt", receipt, booking });
    } catch (failure) {
      failedSubmission(prepared, ticket, failure);
    } finally {
      if (ticket === operation.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  function prepareSubmission(
    activeStage: Extract<Stage, { kind: "form" | "pending" }>
  ): PreparedCreate | undefined {
    if (activeStage.kind === "form") {
      setError("");
      if (!nameInput.current?.reportValidity() || !emailInput.current?.reportValidity()) return;
      const invalid = parseGuests(draft.guests.map((row) => row.value)) === null;
      setGuestInvalid(invalid);
      if (invalid) return;
    }
    try {
      const store = attempts();
      const pending =
        activeStage.kind === "pending"
          ? activeStage
          : store.begin({
              start: activeStage.start,
              ...draft,
              guests: draft.guests.map((row) => row.value),
              timeZone,
            });
      store.verify(pending);
      return { store, pending };
    } catch (failure) {
      invalidAttempt(failure);
    }
  }
  function failedSubmission({ store, pending }: PreparedCreate, ticket: number, failure: unknown): void {
    if (ticket !== operation.current) return;
    try {
      if (store.reject(pending.request.requestKey, failure)) {
        setStage({ kind: "form", start: pending.request.start });
        setDraft({
          name: pending.request.name,
          email: pending.request.email,
          notes: pending.request.notes ?? "",
          guests: (pending.request.guests ?? []).map((value) => ({ id: crypto.randomUUID(), value })),
        });
        setError(labels.slotConflict);
      } else setError(labels.bookingError);
    } catch {
      setError(labels.storageError);
    }
  }
  function invalidAttempt(failure: unknown): void {
    if (failure instanceof ErrorWithCode && failure.code === "invalid_input") {
      setError(labels.invalidInput);
      return;
    }
    if (failure instanceof ErrorWithCode && failure.code === "request_too_large") {
      setError(labels.requestTooLarge);
      return;
    }
    if (stage.kind !== "pending") setStage({ kind: "blocked" });
    setError(labels.storageError);
  }
  const selectedZone = stage.kind === "pending" ? stage.request.timeZone : timeZone;
  const selectedLabel = selected
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: selectedZone,
        hour12: format === "h:mma",
      }).format(new Date(selected))
    : undefined;
  const appointment = selected
    ? {
        date: new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: selectedZone }).format(
          new Date(selected)
        ),
        time: new Intl.DateTimeFormat("en-US", {
          timeStyle: "short",
          timeZone: selectedZone,
          hour12: format === "h:mma",
        })
          .format(new Date(selected))
          .toLowerCase(),
      }
    : undefined;
  const durationLabel = formatDuration(event.durationMinutes, (count, unit) =>
    labels.duration[unit][count === 1 ? "one" : "other"].replaceAll("{{count}}", String(count))
  );
  const timeFormatToggle = <TimeFormatToggle value={format} onChange={setFormat} labels={labels} />;
  const formActive = stage.kind === "form" || stage.kind === "pending";
  const calendar = calendarPresentation(stage, width, layout, event.durationMinutes);
  const { view, showCalendar } = calendar;
  const wide = view.kind !== "month";
  if (stage.kind === "receipt") {
    return (
      <BookingReceipt
        stage={stage}
        labels={labels}
        format={format}
        busy={busy}
        error={error}
        onUpdated={(booking) => setStage({ ...stage, booking })}
        onCheckStatus={() => void loadReceipt(stage.receipt)}
      />
    );
  }
  const layoutToggle = (
    <BookerLayoutToggle
      value={wide ? layout : "month_view"}
      labels={labels}
      onChange={setLayout}
      onCursorChange={setCursor}
    />
  );
  const metadata = (
    <BookerMetadata
      organizer={organizer}
      event={event}
      labels={labels}
      stage={stage}
      calendar={calendar}
      timeZone={timeZone}
      zones={zones}
      onTimeZoneChange={setTimeZone}
      selected={selected}
      selectedLabel={selectedLabel}
      durationLabel={durationLabel}
      timeFormatToggle={timeFormatToggle}
    />
  );
  return (
    <BookerFrame calendar={calendar} stage={stage} layoutToggle={layoutToggle}>
      {showCalendar ? (
        <BookingCalendar
          access={{ kind: "event", id: eventId }}
          metadata={metadata}
          view={view}
          layoutToggle={layoutToggle}
          cursor={cursor}
          onCursorChange={setCursor}
          returnFocusTime={returnFocusTime}
          locale="en-US"
          timeZone={timeZone}
          timeFormat={format}
          timeFormatToggle={timeFormatToggle}
          labels={labels}
          selectedTime={selected}
          onTimeSelect={(value) => {
            setReturnFocusTime(undefined);
            setError("");
            setStage({ kind: "form", start: Date.parse(value) });
          }}
        />
      ) : (
        metadata
      )}
      {stage.kind !== "calendar" && (
        <BookingFormDialog
          active={formActive}
          forceModal={wide}
          heading={labels.confirmDetails}
          summary={
            selected && (
              <div className="my-4 flex flex-wrap gap-2 rounded-md leading-none">
                <div className="inline-flex items-center justify-center gap-x-1 rounded-lg bg-gray-100 px-1.5 py-1 font-medium text-gray-800 text-sm leading-none dark:bg-darkgray-200 dark:text-darkgray-800">
                  <Icon name="calendar" size={12} className="shrink-0 stroke-[3px]" />
                  <time dateTime={selected} className="contents">
                    {appointment?.date}, {appointment?.time}
                  </time>
                </div>
                <div className="inline-flex items-center justify-center gap-x-1 rounded-lg bg-gray-100 px-1.5 py-1 font-medium text-gray-800 text-sm leading-none dark:bg-darkgray-200 dark:text-darkgray-800">
                  <Icon name="clock" size={12} className="shrink-0 stroke-[3px]" />
                  <span>{durationLabel}</span>
                </div>
                <span className="text-subtle w-full text-sm">{selectedZone}</span>
              </div>
            )
          }
          locked={busy || stage.kind === "pending"}
          onBack={back}>
          {stage.kind === "loading" && <p role="status">{labels.loading}</p>}
          {(stage.kind === "form" || stage.kind === "pending") && (
            <BookingDraftForm
              stage={stage}
              draft={draft}
              onDraftChange={setDraft}
              guestInvalid={guestInvalid}
              onGuestInvalidChange={setGuestInvalid}
              nameInput={nameInput}
              emailInput={emailInput}
              busy={busy}
              error={error}
              labels={labels}
              onSubmit={submit}
              onBack={back}
            />
          )}
          {stage.kind === "blocked" && (
            <>
              <p role="alert">{error}</p>
              <Button onClick={restore}>{labels.retry}</Button>
            </>
          )}
        </BookingFormDialog>
      )}
    </BookerFrame>
  );
}

type CalendarPresentation = { view: CalendarView; showCalendar: boolean };

function BookerFrame({
  calendar,
  stage,
  layoutToggle,
  children,
}: {
  calendar: CalendarPresentation;
  stage: Stage;
  layoutToggle: ReactElement;
  children: ReactNode;
}): ReactElement {
  const wide = calendar.view.kind !== "month";
  const formActive = stage.kind === "form" || stage.kind === "pending";
  return (
    <div
      className={`main text-default flex min-h-full w-full flex-col items-center ${wide ? "overflow-clip" : "overflow-visible min-[769px]:my-20"}`}>
      <div className="fixed right-4 top-4 z-20 hidden min-[769px]:block">{layoutToggle}</div>
      <div
        data-testid="booker-container"
        className={
          wide
            ? "bg-default grid min-h-screen h-auto w-screen max-w-full grid-cols-[var(--booker-meta-width)_1fr] grid-rows-[70px_auto] [grid-template-areas:'meta_header_header'_'meta_main_main'] [--booker-meta-width:340px] lg:[--booker-meta-width:424px] sm:transition-[width] sm:duration-300 sm:motion-reduce:transition-none"
            : formActive
              ? "bg-default border-subtle dark:bg-cal-muted grid w-full max-w-full items-start [--booker-main-width:420px] [--booker-meta-width:240px] min-[769px]:min-h-[450px] min-[769px]:w-[calc(var(--booker-meta-width)+var(--booker-main-width))] min-[769px]:rounded-md min-[769px]:border min-[769px]:grid-cols-[var(--booker-meta-width)_var(--booker-main-width)] min-[769px]:grid-rows-[1fr_0fr] lg:[--booker-meta-width:340px]"
              : "bg-default border-subtle dark:bg-cal-muted grid w-full max-w-full items-start [--booker-main-width:480px] [--booker-meta-width:240px] [--booker-timeslots-width:240px] min-[769px]:min-h-[450px] min-[769px]:w-[calc(var(--booker-meta-width)+var(--booker-main-width)+var(--booker-timeslots-width))] min-[769px]:rounded-md min-[769px]:border min-[769px]:grid-cols-[var(--booker-meta-width)_1fr_var(--booker-timeslots-width)] lg:[--booker-meta-width:280px] lg:[--booker-timeslots-width:280px]"
        }>
        {children}
      </div>
      {!wide && <span className="mb-6 mt-auto hidden pt-6 min-[769px]:block" aria-hidden="true" />}
    </div>
  );
}

function selectedStart(stage: Stage): number | undefined {
  if (stage.kind === "form") return stage.start;
  if (stage.kind === "pending") return stage.request.start;
  if (stage.kind === "receipt") return stage.booking?.start;
}

function calendarPresentation(
  stage: Stage,
  width: number,
  layout: BookerLayout,
  duration: number
): CalendarPresentation {
  const formActive = stage.kind === "form" || stage.kind === "pending";
  let view: CalendarView = { kind: "month" };
  if (width > 768 && (stage.kind === "calendar" || formActive) && layout !== "month_view") {
    if (layout === "week_view") view = { kind: "week", count: width <= 1024 ? 4 : 7, duration };
    else view = { kind: "column", count: width <= 1024 ? 2 : 6 };
  }
  return { view, showCalendar: stage.kind === "calendar" || (view.kind !== "month" && formActive) };
}

function BookingReceipt({
  stage,
  labels,
  format,
  busy,
  error,
  onUpdated,
  onCheckStatus,
}: {
  stage: Extract<Stage, { kind: "receipt" }>;
  labels: PublicBookerProps["labels"];
  format: ComponentProps<typeof TimeFormatToggle>["value"];
  busy: boolean;
  error: string;
  onUpdated: (booking: Booking) => void;
  onCheckStatus: () => void;
}): ReactElement {
  return (
    <div className="text-default mx-auto min-h-full w-full self-start px-4 py-8">
      {stage.booking ? (
        <BookingManagement
          booking={stage.booking}
          access={stage.receipt.access}
          labels={labels}
          timeFormat={format}
          onUpdated={onUpdated}
        />
      ) : (
        <section className="border-subtle mx-auto max-w-xl space-y-4 rounded-lg border p-8">
          <h1 className="text-emphasis text-2xl font-semibold" aria-live="polite">
            {busy ? labels.loading : labels.statusUnavailable}
          </h1>
          {error && <p role="alert">{error}</p>}
          <Button color="secondary" loading={busy} onClick={onCheckStatus}>
            {labels.checkStatus}
          </Button>
        </section>
      )}
    </div>
  );
}

function BookerLayoutToggle({
  value,
  labels,
  onChange,
  onCursorChange,
}: {
  value: BookerLayout;
  labels: PublicBookerProps["labels"];
  onChange: (layout: BookerLayout) => void;
  onCursorChange: Dispatch<SetStateAction<CalendarCursor>>;
}): ReactElement {
  return (
    <Provider>
      <ToggleGroup.Root
        type="single"
        value={value}
        aria-label={labels.layout}
        onValueChange={(next) => {
          if (next !== "month_view" && next !== "column_view" && next !== "week_view") return;
          onChange(next);
          if (next !== "month_view")
            onCursorChange((previous) => ({
              ...previous,
              date: previous.date ?? dayjs().format("YYYY-MM-DD"),
            }));
          const url = new URL(location.href);
          url.searchParams.set("layout", next);
          history.replaceState(null, "", url);
        }}
        className="bg-muted inline-flex gap-0.5 rounded-[10px] p-0.5">
        {layouts.map(({ value, label, icon }) => (
          <Tooltip key={value} content={labels[label]} side="bottom" sideOffset={12}>
            <ToggleGroup.Item
              value={value}
              className="aria-checked:bg-default aria-checked:border-subtle rounded-lg border border-transparent p-1.5 text-sm leading-none transition aria-checked:shadow-[0px_2px_3px_0px_rgba(0,0,0,0.03),0px_2px_2px_-1px_rgba(0,0,0,0.03)] text-default [&[aria-checked='false']]:hover:text-emphasis [&[aria-checked='false']]:hover:bg-subtle cursor-pointer">
              <Icon name={icon} />
              <span className="sr-only">{labels[label]}</span>
            </ToggleGroup.Item>
          </Tooltip>
        ))}
      </ToggleGroup.Root>
    </Provider>
  );
}

function BookerMetadata({
  organizer,
  event,
  labels,
  stage,
  calendar,
  timeZone,
  zones,
  onTimeZoneChange,
  selected,
  selectedLabel,
  durationLabel,
  timeFormatToggle,
}: Pick<PublicBookerProps, "organizer" | "event" | "labels"> & {
  stage: Stage;
  calendar: CalendarPresentation;
  timeZone: string;
  zones: ComponentProps<typeof TimezoneSelect>["data"];
  onTimeZoneChange: (zone: string) => void;
  selected: string | undefined;
  selectedLabel: string | undefined;
  durationLabel: ReturnType<typeof formatDuration>;
  timeFormatToggle: ReactElement;
}): ReactElement {
  return (
    <section className="relative z-10 p-6" data-testid="event-meta">
      <ul className="border-muted flex items-center">
        <li className="-mr-1 inline-block">
          <span className={`${avatarClass} border-subtle overflow-hidden`}>
            <img src={avatar} alt={organizer.name} className={`${avatarClass} border-default`} />
          </span>
        </li>
      </ul>
      <p className="text-subtle mt-2 text-sm font-semibold [overflow-wrap:anywhere]">{organizer.name}</p>
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
          {durationLabel}
        </EventMetaBlock>
        <EventMetaBlock
          icon="globe"
          className="cursor-pointer [&_.current-timezone:before]:focus-within:opacity-100 [&_.current-timezone:before]:hover:opacity-100"
          contentClassName="relative max-w-[90%]">
          {calendar.showCalendar || stage.kind === "loading" ? (
            <span className="current-timezone before:bg-subtle min-w-32 -mt-[2px] flex h-6 max-w-full items-center justify-start before:absolute before:inset-0 before:bottom-[-3px] before:left-[-30px] before:top-[-3px] before:w-[calc(100%+35px)] before:rounded-md before:py-3 before:opacity-0 before:transition-opacity">
              <TimezoneSelect
                value={timeZone}
                onChange={onTimeZoneChange}
                data={zones}
                label={labels.timeZone}
                disabled={stage.kind !== "calendar"}
              />
            </span>
          ) : (
            timeZone
          )}
        </EventMetaBlock>
        {!calendar.showCalendar && timeFormatToggle}
        {selected && calendar.view.kind === "month" && (
          <EventMetaBlock icon="calendar" role="status">
            {labels.selectedTime}
            <br />
            <time dateTime={selected}>{selectedLabel}</time>
          </EventMetaBlock>
        )}
      </div>
    </section>
  );
}

function BookingDraftForm({
  stage,
  draft,
  onDraftChange,
  guestInvalid,
  onGuestInvalidChange,
  nameInput,
  emailInput,
  busy,
  error,
  labels,
  onSubmit,
  onBack,
}: {
  stage: Extract<Stage, { kind: "form" | "pending" }>;
  draft: BookingDraft;
  onDraftChange: (draft: BookingDraft) => void;
  guestInvalid: boolean;
  onGuestInvalidChange: (invalid: boolean) => void;
  nameInput: ComponentProps<typeof Input>["ref"];
  emailInput: ComponentProps<typeof Input>["ref"];
  busy: boolean;
  error: string;
  labels: PublicBookerProps["labels"];
  onSubmit: () => Promise<void>;
  onBack: () => void;
}): ReactElement {
  const readOnly = busy || stage.kind === "pending";
  return (
    <form
      noValidate
      className="flex h-full flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}>
      <div className="flex flex-col gap-4 pb-4">
        <div>
          <Label htmlFor="booker-name">
            {labels.publicName}
            <span aria-hidden="true" className="text-default ml-1 font-medium">
              *
            </span>
          </Label>
          <Input
            ref={nameInput}
            className="min-w-0 truncate rounded-lg font-medium leading-none focus:outline-none focus:ring-0"
            id="booker-name"
            name="name"
            autoComplete="name"
            required
            maxLength={200}
            pattern=".*\S.*"
            readOnly={readOnly}
            value={stage.kind === "pending" ? stage.request.name : draft.name}
            onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="booker-email" className="flex w-fit items-center">
            <span>{labels.publicEmail}</span>
            <span aria-hidden="true" className="text-emphasis -mb-1 ml-1 text-sm font-medium leading-none">
              *
            </span>
          </Label>
          <Input
            ref={emailInput}
            className="min-w-0 truncate rounded-lg font-medium leading-none focus:outline-none focus:ring-0"
            id="booker-email"
            type="email"
            name="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            required
            maxLength={254}
            readOnly={readOnly}
            value={stage.kind === "pending" ? stage.request.email : draft.email}
            onChange={(event) => onDraftChange({ ...draft, email: event.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="notes" className="flex w-fit items-center">
            <span>{labels.notes}</span>
            <span aria-hidden="true" className="-mb-1 ml-1" />
          </Label>
          <TextArea
            id="notes"
            name="notes"
            rows={3}
            placeholder={labels.notesPlaceholder}
            className="mb-2 resize-y leading-5"
            readOnly={readOnly}
            value={stage.kind === "pending" ? (stage.request.notes ?? "") : draft.notes}
            onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })}
          />
        </div>
        <GuestFields
          rows={
            stage.kind === "pending"
              ? (stage.request.guests ?? []).map((value) => ({ id: value, value }))
              : draft.guests
          }
          onChange={(guests) => {
            onDraftChange({ ...draft, guests });
            onGuestInvalidChange(false);
          }}
          readOnly={readOnly}
          invalid={guestInvalid}
          labels={labels}
        />
      </div>
      {stage.kind === "pending" && <p role="status">{labels.pending}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="my-3 w-full text-subtle text-xs">
        {labels.agreement.split(/(<0>.*?<\/0>|<1>.*?<\/1>)/).map((part) =>
          part.startsWith("<0>") || part.startsWith("<1>") ? (
            <a
              key={part}
              className="text-emphasis hover:underline"
              href={part.startsWith("<0>") ? "https://cal.com/terms" : "https://cal.com/privacy"}
              target="_blank"
              rel="noopener noreferrer">
              {part.slice(3, -4)}
            </a>
          ) : (
            part
          )
        )}
      </div>
      <div className="modalsticky mt-auto flex justify-end space-x-2">
        <Button color="minimal" disabled={readOnly} onClick={onBack}>
          {labels.back}
        </Button>
        <Button type="submit" loading={busy}>
          {stage.kind === "pending" ? labels.retry : labels.confirm}
        </Button>
      </div>
    </form>
  );
}

export { PublicBooker };
