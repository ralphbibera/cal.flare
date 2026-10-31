import { Provider } from "@radix-ui/react-tooltip";
import dayjs, { type Dayjs } from "dayjs";
import type { ReactElement, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CalendarAccess, useCalendarAvailability } from "../client/use-calendar-availability.ts";
import { Button } from "./Button.tsx";
import { ColumnTimeSlots } from "./ColumnTimeSlots.tsx";
import { MonthPicker } from "./MonthPicker.tsx";
import { TimeSlots } from "./TimeSlots.tsx";
import { TimeSlotsHeader } from "./TimeSlotsHeader.tsx";
import { TimeSlotsSkeleton } from "./TimeSlotsSkeleton.tsx";
import { WeekTimeGrid } from "./WeekTimeGrid.tsx";

type CalendarCursor = { month: string; date: string | null };
type CalendarView =
  | { kind: "month" }
  | { kind: "column"; count: 2 | 6 }
  | { kind: "week"; count: 4 | 7; duration: number };
type CalendarControl =
  | { cursor: CalendarCursor; onCursorChange: (cursor: CalendarCursor) => void }
  | { cursor?: never; onCursorChange?: never };

type BookingCalendarProps = CalendarControl & {
  metadata?: ReactNode;
  view?: CalendarView;
  layoutToggle?: ReactElement;
  timeZone: string;
  timeFormat: "h:mma" | "HH:mm";
  timeFormatToggle?: ReactElement;
  locale: string;
  weekStart?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  labels: {
    today: string;
    previousMonth: string;
    nextMonth: string;
    previousDay?: string;
    nextDay?: string;
    loading: string;
    error: string;
    retry: string;
    empty: string;
  };
  access?: CalendarAccess;
  selectedTime?: string;
  returnFocusTime?: string;
  onTimeSelect: (time: string) => void;
};
type AvailabilityResult = ReturnType<typeof useCalendarAvailability>["result"];
type CalendarDays = Extract<AvailabilityResult, { status: "ready" }>["days"];

function BookingCalendar({
  metadata,
  view = { kind: "month" },
  layoutToggle,
  timeZone,
  timeFormat,
  timeFormatToggle,
  locale,
  weekStart,
  labels,
  access,
  selectedTime,
  cursor,
  onCursorChange,
  returnFocusTime,
  onTimeSelect,
}: BookingCalendarProps): ReactElement {
  const wide = view.kind !== "month";
  const [localCursor, setLocalCursor] = useState<CalendarCursor>(() => ({
    month: dayjs().format("YYYY-MM"),
    date: null,
  }));
  const current = cursor ?? localCursor;
  const { month, date: selectedDate } = current;
  const changeCursor = useCallback(
    (next: CalendarCursor) => {
      if (next.month === current.month && next.date === current.date) return;
      if (onCursorChange) onCursorChange(next);
      else setLocalCursor(next);
    },
    [current, onCursorChange]
  );
  const calendar = useRef<HTMLDivElement>(null);
  const focusOrigin = useRef<HTMLButtonElement | null>(null);
  const focusReturned = useRef(false);
  const timeList = useRef<HTMLDivElement>(null);
  const scrolledToTimes = useRef(false);
  const { result, refresh } = useCalendarAvailability(month, timeZone, access);
  const { days, times, anchor, empty, jump, endDate } = calendarPage({ view, result, selectedDate, month });
  const today = dayjs().startOf("day");
  const coverage = result.status === "ready" ? result.coverage : undefined;
  const { first, horizon, forwardLimit } = calendarBounds(coverage, timeZone, anchor);
  function move(amount: number): void {
    const next = anchor.add(amount, "day");
    const lower =
      view.kind === "column" && first.subtract(1, "day").isAfter(today) ? first.subtract(1, "day") : today;
    const upper = view.kind === "week" ? horizon : forwardLimit;
    let date = next;
    if (amount < 0 && next.isBefore(lower)) date = lower;
    else if (amount > 0 && next.isAfter(upper)) date = upper;
    changeCursor({ month: date.format("YYYY-MM"), date: date.format("YYYY-MM-DD") });
  }
  useEffect(() => {
    if (wide || result.status !== "ready" || month !== dayjs().format("YYYY-MM")) return;
    if (Object.keys(result.days).some((date) => date.startsWith(`${month}-`))) return;
    const next = dayjs(`${month}-01`).add(1, "month");
    changeCursor({ month: next.format("YYYY-MM"), date: next.format("YYYY-MM-DD") });
  }, [result, month, changeCursor, wide]);
  useLayoutEffect(() => {
    focusReturned.current = false;
    if (!returnFocusTime) return;
    focusOrigin.current = calendar.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? null;
    focusOrigin.current?.focus();
  }, [returnFocusTime]);
  useEffect(() => {
    if (!returnFocusTime || focusReturned.current || result.status !== "ready") return;
    focusReturned.current = true;
    if (document.activeElement !== focusOrigin.current) return;
    const slot = Array.from(
      timeList.current?.querySelectorAll<HTMLButtonElement>("button[data-time], button[data-slot]") ?? []
    ).find((button) => (button.dataset.time ?? button.dataset.slot) === returnFocusTime);
    const target = slot ?? calendar.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (target) {
      target.focus();
    }
  }, [returnFocusTime, result]);
  return (
    <Provider>
      {!wide && metadata}
      <div
        ref={calendar}
        className={
          wide
            ? "[grid-area:meta]"
            : "h-full shrink px-5 py-3 [@media(max-width:768px)]:relative [@media(max-width:768px)]:z-1 min-[769px]:border-subtle min-[769px]:-ml-px min-[769px]:border-l lg:w-(--booker-main-width)"
        }
        aria-busy={result.status === "loading"}>
        {wide && metadata}
        <MonthPicker
          className={wide ? "mt-auto px-5 py-3" : undefined}
          locale={locale}
          labels={labels}
          browsingDate={dayjs(`${month}-01`)}
          selected={selectedDate ? dayjs(selectedDate) : null}
          onChange={(date) => changeCursor({ month, date: date?.format("YYYY-MM-DD") ?? null })}
          onMonthChange={(date) => {
            const terminal = horizon.add(1, "day");
            const target = wide && coverage && date.isAfter(terminal, "day") ? terminal : date;
            changeCursor({ month: target.format("YYYY-MM"), date: target.format("YYYY-MM-DD") });
          }}
          includedDates={Object.keys(days)}
          slots={days}
          weekStart={weekStart}
          isLoading={result.status === "loading"}
          isCompact={wide}
          skipAutomaticSelection={result.status !== "ready" || wide}
          scrollToTimeSlots={() => {
            if (!matchMedia("(max-width: 768px)").matches || scrolledToTimes.current || !timeList.current)
              return;
            timeList.current.scrollIntoView({ behavior: "smooth" });
            scrolledToTimes.current = true;
          }}
        />
        {result.status === "loading" && (
          <p role="status" className="sr-only">
            {labels.loading}
          </p>
        )}
        {result.status === "error" && (
          <div role="alert">
            <p>{labels.error}</p>
            <Button onClick={refresh} color="secondary">
              {labels.retry}
            </Button>
          </div>
        )}
        {result.status === "ready" && empty && <p role="status">{labels.empty}</p>}
      </div>
      {wide && (
        <>
          {calendarHeader({
            anchor,
            endDate,
            jump,
            today,
            horizon,
            status: result.status,
            labels,
            timeFormatToggle,
            layoutToggle,
            move,
            changeCursor,
          })}
          {wideTimeSlots({
            view,
            status: result.status,
            days,
            anchor,
            timeList,
            locale,
            timeZone,
            timeFormat,
            onTimeSelect,
            selectedTime,
          })}
        </>
      )}
      {!wide &&
        monthTimeSlots({
          status: result.status,
          times,
          selectedDate,
          timeList,
          locale,
          timeZone,
          timeFormat,
          timeFormatToggle,
          selectedTime,
          onTimeSelect,
        })}
    </Provider>
  );
}

function calendarPage({
  view,
  result,
  selectedDate,
  month,
}: {
  view: CalendarView;
  result: AvailabilityResult;
  selectedDate: string | null;
  month: string;
}): {
  days: CalendarDays;
  times: CalendarDays[string];
  anchor: Dayjs;
  empty: boolean;
  jump: number;
  endDate: Dayjs;
} {
  const days = result.status === "ready" ? result.days : {};
  const times = selectedDate ? (days[selectedDate] ?? []) : [];
  const anchor = dayjs(selectedDate ?? dayjs().format("YYYY-MM-DD"));
  const columns = view.kind === "column" ? view.count : undefined;
  const empty =
    view.kind === "week"
      ? !Array.from(
          { length: view.count },
          (_, offset) => days[anchor.add(offset, "day").format("YYYY-MM-DD")]?.length
        ).some(Boolean)
      : Object.keys(days).length === 0;
  const available = Object.keys(days)
    .filter((date) => days[date].length > 0 && dayjs(date).diff(anchor, "day") >= 0)
    .sort();
  const spansMonths = available.slice(0, columns).some((date) => !anchor.isSame(dayjs(date), "month"));
  const pagination = spansMonths ? available : available.filter((date) => date.startsWith(`${month}-`));
  const slots = pagination.slice(0, (columns ?? 0) + 1);
  const addon = columns && pagination.length < columns ? (columns - pagination.length + 1) * 7 : 0;
  const last = slots.at(-1);
  const end = slots[slots.length === (columns ?? 0) + 1 ? slots.length - 2 : slots.length - 1];
  if (view.kind === "week")
    return { days, times, anchor, empty, jump: view.count, endDate: anchor.add(view.count - 1, "day") };
  return {
    days,
    times,
    anchor,
    empty,
    jump: last ? Math.abs(anchor.diff(last, "day")) + addon : 0,
    endDate: end ? anchor.add(Math.abs(anchor.diff(end, "day")) + addon, "day") : anchor,
  };
}

function calendarBounds(
  coverage: Extract<AvailabilityResult, { status: "ready" }>["coverage"] | undefined,
  timeZone: string,
  anchor: Dayjs
): { first: Dayjs; horizon: Dayjs; forwardLimit: Dayjs } {
  function civilDay(epoch: number): Dayjs {
    return dayjs(dayjs(epoch).tz(timeZone).format("YYYY-MM-DD"));
  }
  const first = coverage ? civilDay(coverage.from) : anchor;
  const boundary = coverage ? civilDay(coverage.to) : anchor;
  const horizon = coverage ? civilDay(coverage.horizon - 1) : anchor;
  const forwardLimit = boundary.isBefore(horizon, "day") ? boundary : horizon;
  return { first, horizon, forwardLimit };
}

function calendarHeader({
  anchor,
  endDate,
  jump,
  today,
  horizon,
  status,
  labels,
  timeFormatToggle,
  layoutToggle,
  move,
  changeCursor,
}: Pick<BookingCalendarProps, "labels" | "timeFormatToggle" | "layoutToggle"> & {
  anchor: Dayjs;
  endDate: Dayjs;
  jump: number;
  today: Dayjs;
  horizon: Dayjs;
  status: AvailabilityResult["status"];
  move: (amount: number) => void;
  changeCursor: (cursor: CalendarCursor) => void;
}): ReactElement {
  return (
    <div className="bg-default border-default sticky top-0 z-10 flex border-b px-5 py-4 ltr:border-l rtl:border-r [grid-area:header]">
      <div className="flex items-center gap-5">
        <h3 className="min-w-[150px] text-base font-semibold leading-4">
          {anchor.format("MMM D")}
          {!anchor.isSame(endDate, "year") && <span className="text-subtle">, {anchor.format("YYYY")} </span>}
          - {!anchor.isSame(endDate, "month") && `${endDate.format("MMM")} `}
          {endDate.format("D")}, <span className="text-subtle">{endDate.format("YYYY")}</span>
        </h3>
        <div className="flex space-x-2">
          <Button
            variant="icon"
            color="minimal"
            StartIcon="chevron-left"
            aria-label={labels.previousDay}
            disabled={status !== "ready"}
            onClick={() => move(-(jump || 7))}
          />
          <Button
            variant="icon"
            color="minimal"
            StartIcon="chevron-right"
            aria-label={labels.nextDay}
            disabled={status !== "ready" || !anchor.isBefore(horizon, "day")}
            onClick={() => move(jump || 7)}
          />
          {Math.abs(dayjs().diff(anchor, "day")) > 3 && (
            <Button
              color="secondary"
              className="capitalize ltr:ml-2"
              onClick={() =>
                changeCursor({ month: today.format("YYYY-MM"), date: today.format("YYYY-MM-DD") })
              }>
              {labels.today}
            </Button>
          )}
        </div>
      </div>
      <div className="ml-auto flex gap-2">
        {timeFormatToggle}
        <div className="pointer-events-none opacity-0" aria-hidden inert>
          {layoutToggle}
        </div>
      </div>
    </div>
  );
}

function wideTimeSlots({
  view,
  status,
  days,
  anchor,
  timeList,
  locale,
  timeZone,
  timeFormat,
  onTimeSelect,
  selectedTime,
}: Pick<BookingCalendarProps, "locale" | "timeZone" | "timeFormat" | "onTimeSelect" | "selectedTime"> & {
  view: Exclude<CalendarView, { kind: "month" }>;
  status: AvailabilityResult["status"];
  days: CalendarDays;
  anchor: Dayjs;
  timeList: RefObject<HTMLDivElement | null>;
}): ReactElement {
  return (
    <div
      ref={timeList}
      aria-busy={status === "loading"}
      className={
        view.kind === "week"
          ? "border-subtle sticky top-0 -ml-px h-full min-[769px]:border-l [grid-area:main] [--calendar-dates-sticky-offset:66px]"
          : "border-subtle flex h-full w-full flex-col overflow-x-auto px-5 py-3 pb-0 ltr:border-l [grid-area:main]"
      }>
      {view.kind === "week" ? (
        <WeekTimeGrid
          {...(status === "ready" ? { status: "ready", days } : { status })}
          date={anchor.format("YYYY-MM-DD")}
          count={view.count}
          duration={view.duration}
          locale={locale}
          timeZone={timeZone}
          timeFormat={timeFormat}
          onSelect={onTimeSelect}
        />
      ) : (
        <ColumnTimeSlots
          days={days}
          date={anchor.format("YYYY-MM-DD")}
          count={view.count}
          locale={locale}
          loading={status === "loading"}
          timeZone={timeZone}
          timeFormat={timeFormat}
          onSelect={onTimeSelect}
          selectedSlots={selectedTime ? [selectedTime] : []}
        />
      )}
    </div>
  );
}

function monthTimeSlots({
  status,
  times,
  selectedDate,
  timeList,
  locale,
  timeZone,
  timeFormat,
  timeFormatToggle,
  selectedTime,
  onTimeSelect,
}: Pick<
  BookingCalendarProps,
  "locale" | "timeZone" | "timeFormat" | "timeFormatToggle" | "selectedTime" | "onTimeSelect"
> & {
  status: AvailabilityResult["status"];
  times: CalendarDays[string];
  selectedDate: string | null;
  timeList: RefObject<HTMLDivElement | null>;
}): ReactElement | false {
  return (
    (status === "loading" || (status === "ready" && times.length > 0)) && (
      <div
        ref={timeList}
        className="border-subtle rtl:border-default flex h-full w-full flex-col overflow-x-auto px-5 py-3 pb-0 rtl:border-r [@media(max-width:768px)]:sticky [@media(max-width:768px)]:top-0 min-[769px]:w-[var(--booker-timeslots-width,100%)] min-[769px]:overflow-hidden ltr:md:border-l">
        {status === "loading" ? (
          <div aria-hidden="true">
            <div className="flex">
              <div className="mb-3 h-8" />
            </div>
            <div className="flex h-full w-full flex-row gap-4">
              <TimeSlotsSkeleton />
            </div>
          </div>
        ) : (
          <>
            <div className="flex">
              <TimeSlotsHeader
                weekday={new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
                  dayjs(selectedDate).toDate()
                )}
                day={dayjs(selectedDate).format("DD")}
                isToday={dayjs().isSame(dayjs(selectedDate), "day")}
                timeFormatToggle={timeFormatToggle}
              />
            </div>
            <div className="no-scrollbar flex h-full w-full flex-row gap-4 min-[769px]:block min-[769px]:h-[400px] min-[769px]:grow min-[769px]:overflow-auto">
              <div className="no-scrollbar overflow-x-hidden! h-full w-full overflow-y-auto">
                <TimeSlots
                  slots={times}
                  timeZone={timeZone}
                  timeFormat={timeFormat}
                  onSelect={onTimeSelect}
                  selectedSlots={selectedTime ? [selectedTime] : []}
                />
              </div>
            </div>
          </>
        )}
      </div>
    )
  );
}

export { BookingCalendar, type BookingCalendarProps, type CalendarCursor, type CalendarView };
