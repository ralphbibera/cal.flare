import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useEffect } from "react";
import { twMerge } from "tailwind-merge";
import { Button } from "./Button.tsx";
import { CalendarDay } from "./CalendarDay.tsx";
import { Tooltip } from "./Tooltip.tsx";

type MonthSlot = {
  time?: string;
  away?: boolean;
  emoji?: string | null;
  toUser?: { username: string } | null;
  showNotePublicly?: boolean;
};

type MonthDay = {
  date: Dayjs | null;
  disabled: boolean;
  away?: boolean;
  emoji?: string | null;
  active?: boolean;
  tooltip?: string | null;
  monthLabel?: string;
};

type MonthPickerProps = {
  locale: string;
  labels: { today: string; previousMonth: string; nextMonth: string };
  browsingDate?: Dayjs;
  selected?: Dayjs | Dayjs[] | null;
  onChange: (date: Dayjs | null, omitUpdatingParams?: boolean) => void;
  onMonthChange?: (date: Dayjs) => void;
  weekStart?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  minDate?: Date;
  includedDates?: string[];
  excludedDates?: string[];
  slots?: Record<string, MonthSlot[]>;
  selectedDates?: string[];
  skipAutomaticSelection?: boolean;
  scrollToTimeSlots?: () => void;
  isLoading?: boolean;
  isCompact?: boolean;
  className?: string;
  customClassNames?: {
    datePickerTitle?: string;
    datePickerDays?: string;
    datePickersDates?: string;
    datePickerDatesActive?: string;
    datePickerToggle?: string;
  };
};

function availableDates(browsingDate: Dayjs, minDate?: Date, includedDates?: string[]) {
  const available: string[] = [];
  const minimum = minDate || new Date();
  const nativeDate = browsingDate.toDate();
  // Availability follows the native browser date; the visible grid retains the supplied offset.
  const nativeMonthDays = new Date(nativeDate.getFullYear(), nativeDate.getMonth() + 1, 0).getDate();
  const lastDate = new Date(nativeDate.getFullYear(), nativeDate.getMonth(), nativeMonthDays);
  for (
    let date = nativeDate > minimum ? nativeDate : minimum;
    date < lastDate || dayjs(date).isSame(lastDate, "day");
    date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
  ) {
    const key = dayjs(date).format("YYYY-MM-DD");
    if (!includedDates || includedDates.includes(key)) available.push(key);
  }
  return available;
}

function nextMonthLabels(date: Dayjs, visible: boolean, disabled: boolean) {
  return {
    tooltip: visible && !disabled ? date.format("MMMM") : null,
    monthLabel: visible && date.date() === 1 ? date.format("MMM") : undefined,
  };
}

function MonthPicker({
  locale,
  labels,
  browsingDate: rawDate = dayjs().startOf("month"),
  selected,
  onChange,
  onMonthChange,
  weekStart = 0,
  minDate,
  includedDates,
  excludedDates = [],
  slots = {},
  selectedDates = [],
  skipAutomaticSelection = false,
  scrollToTimeSlots,
  isLoading,
  isCompact,
  className,
  customClassNames,
}: MonthPickerProps) {
  const browsingDate = minDate && rawDate.valueOf() < minDate.valueOf() ? dayjs(minDate) : rawDate;
  const totalDays = new Date(browsingDate.year(), browsingDate.month() + 1, 0).getDate();
  const available = availableDates(browsingDate, minDate, includedDates);
  const showNextMonthDays = dayjs().isAfter(browsingDate.startOf("month").add(2, "week")) && !isCompact;
  const startDay = showNextMonthDays ? 8 : 1;
  const padding = (browsingDate.set("date", startDay).day() - weekStart + 7) % 7;
  const dates: (Dayjs | null)[] = Array(padding).fill(null);
  for (let day = startDay; day <= totalDays; day++) dates.push(browsingDate.set("date", day));
  if (showNextMonthDays) {
    const extraDays = (dates.length % 7 > 0 ? 7 - (dates.length % 7) : 0) + 7;
    for (let day = 1; day <= extraDays; day++) dates.push(browsingDate.add(1, "month").set("date", day));
  }
  const days = dates.map<MonthDay>((date) => {
    if (!date) return { date: null, disabled: true };
    const key = date.format("YYYY-MM-DD");
    const daySlots = slots[key] || [];
    const awayInfo = daySlots.find((slot) => slot.away);
    const away = daySlots.length > 0 && daySlots.every((slot) => slot.away);
    const nextMonth = date.month() !== browsingDate.month();
    const disabled = away
      ? !(awayInfo?.toUser || awayInfo?.showNotePublicly)
      : nextMonth
        ? !daySlots.some((slot) => !slot.away)
        : !available.includes(key) || excludedDates.includes(key);
    const active = Array.isArray(selected)
      ? selected.some((value) => value.format("YYYY-MM-DD") === key)
      : selected?.format("YYYY-MM-DD") === key ||
        selectedDates.some((value) => dayjs(value).format("YYYY-MM-DD") === key);
    return {
      date,
      disabled,
      away,
      emoji: awayInfo?.emoji,
      active,
      ...nextMonthLabels(date, showNextMonthDays && nextMonth, disabled),
    };
  });
  useEffect(() => {
    if (skipAutomaticSelection || Array.isArray(selected)) return;
    const firstAvailable = days.find((day) => !day.disabled)?.date;
    const selectedAvailable =
      selected &&
      days.some(
        ({ date, disabled }) => date?.format("YYYY-MM-DD") === selected.format("YYYY-MM-DD") && !disabled
      );
    if (!selectedAvailable && firstAvailable) onChange(firstAvailable, selected?.isValid() ? false : true);
    if (selectedAvailable) onChange(dayjs(selected), true);
    if (!firstAvailable) onChange(null);
  });
  const month = new Intl.DateTimeFormat(locale, { month: "long" }).format(
    new Date(browsingDate.year(), browsingDate.month())
  );
  const weekdays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + ((index + weekStart) % 7) - date.getDay());
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  });
  const previousDisabled = !browsingDate.isAfter(dayjs());
  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between text-xl">
        <span className="text-default w-1/2 text-base">
          <time dateTime={browsingDate.format("YYYY-MM")} data-testid="selected-month-label">
            <strong className={twMerge("text-emphasis font-semibold", customClassNames?.datePickerTitle)}>
              {month}
            </strong>{" "}
            <span className={twMerge("text-subtle font-medium", customClassNames?.datePickerTitle)}>
              {browsingDate.format("YYYY")}
            </span>
          </time>
        </span>
        <div className="text-emphasis">
          <div className="flex">
            <Button
              className={twMerge(
                "group p-1 opacity-70 transition hover:opacity-100 rtl:rotate-180",
                previousDisabled && "disabled:text-bookinglighter hover:bg-background hover:opacity-70",
                customClassNames?.datePickerToggle
              )}
              onClick={() => onMonthChange?.(browsingDate.add(-1, "month"))}
              disabled={previousDisabled}
              data-testid="decrementMonth"
              color="minimal"
              variant="icon"
              StartIcon="chevron-left"
              aria-label={labels.previousMonth}
            />
            <Button
              className={twMerge(
                "group p-1 opacity-70 transition hover:opacity-100 rtl:rotate-180",
                `${customClassNames?.datePickerToggle}`
              )}
              onClick={() => onMonthChange?.(browsingDate.add(1, "month"))}
              data-testid="incrementMonth"
              color="minimal"
              variant="icon"
              StartIcon="chevron-right"
              aria-label={labels.nextMonth}
            />
          </div>
        </div>
      </div>
      <div className="border-subtle mb-2 grid grid-cols-7 gap-4 border-b border-t text-center md:mb-0 md:border-0">
        {weekdays.map((weekday) => (
          <div
            key={weekday}
            className={twMerge(
              "text-emphasis my-4 text-xs font-medium uppercase tracking-widest",
              customClassNames?.datePickerDays
            )}>
            {weekday}
          </div>
        ))}
      </div>
      <div className="relative grid grid-cols-7 grid-rows-6 gap-1 text-center">
        {days.map(({ date, disabled, away, emoji, active, tooltip, monthLabel }, index) => (
          <div key={date ? `day-${date.format()}` : `e-${index}`} className="relative w-full pt-[100%]">
            {!date ? (
              <div />
            ) : isLoading ? (
              <button
                className="bg-cal-muted text-muted absolute bottom-0 left-0 right-0 top-0 mx-auto flex w-full items-center justify-center rounded-sm border-transparent text-center font-medium opacity-90 transition"
                disabled>
                <span className="font-size-0 bg-emphasis inline-block animate-pulse rounded-md empty:before:inline-block empty:before:content-[''] h-8 w-9" />
              </button>
            ) : (
              <Tooltip content={tooltip}>
                <CalendarDay
                  day={date.date()}
                  active={!!active}
                  disabled={disabled}
                  isToday={date.format("YYYY-MM-DD") === dayjs().format("YYYY-MM-DD")}
                  todayLabel={labels.today}
                  away={away}
                  emoji={emoji}
                  monthLabel={monthLabel}
                  customClassName={{
                    dayContainer: customClassNames?.datePickersDates,
                    dayActive: customClassNames?.datePickerDatesActive,
                  }}
                  onClick={() => {
                    onChange(date);
                    scrollToTimeSlots?.();
                  }}
                />
              </Tooltip>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export { MonthPicker, type MonthPickerProps, type MonthSlot };
