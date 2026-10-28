import { Provider } from "@radix-ui/react-tooltip";
import dayjs from "dayjs";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { BookingAccess } from "../client/bookings.ts";
import { useCalendarAvailability } from "../client/use-calendar-availability.ts";
import { Button } from "./Button.tsx";
import { MonthPicker } from "./MonthPicker.tsx";
import { TimeSlots } from "./TimeSlots.tsx";
import { TimeSlotsHeader } from "./TimeSlotsHeader.tsx";
import { TimeSlotsSkeleton } from "./TimeSlotsSkeleton.tsx";

type BookingCalendarProps = {
  timeZone: string;
  timeFormat: "h:mma" | "HH:mm";
  timeFormatToggle?: ReactElement;
  locale: string;
  weekStart?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  labels: {
    today: string;
    previousMonth: string;
    nextMonth: string;
    loading: string;
    error: string;
    retry: string;
    empty: string;
  };
  access?: BookingAccess;
  selectedTime?: string;
  onTimeSelect: (time: string) => void;
};

function BookingCalendar({
  timeZone,
  timeFormat,
  timeFormatToggle,
  locale,
  weekStart,
  labels,
  access,
  selectedTime,
  onTimeSelect,
}: BookingCalendarProps) {
  const [month, setMonth] = useState(() => dayjs().format("YYYY-MM"));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const { result, refresh } = useCalendarAvailability(month, timeZone, access);
  const days = result.status === "ready" ? result.days : {};
  const times = selectedDate ? (days[selectedDate] ?? []) : [];
  useEffect(() => {
    if (result.status !== "ready" || month !== dayjs().format("YYYY-MM")) return;
    if (Object.keys(result.days).some((date) => date.startsWith(`${month}-`))) return;
    const next = dayjs(`${month}-01`).add(1, "month");
    setMonth(next.format("YYYY-MM"));
    setSelectedDate(next.format("YYYY-MM-DD"));
  }, [result, month]);
  return (
    <Provider>
      <div
        className="md:border-subtle -ml-px h-full shrink px-5 py-3 md:border-l lg:w-(--booker-main-width)"
        aria-busy={result.status === "loading"}>
        <MonthPicker
          locale={locale}
          labels={labels}
          browsingDate={dayjs(`${month}-01`)}
          selected={selectedDate ? dayjs(selectedDate) : null}
          onChange={(date) => setSelectedDate(date?.format("YYYY-MM-DD") ?? null)}
          onMonthChange={(date) => {
            setMonth(date.format("YYYY-MM"));
            setSelectedDate(date.format("YYYY-MM-DD"));
          }}
          includedDates={Object.keys(days)}
          slots={days}
          weekStart={weekStart}
          isLoading={result.status === "loading"}
          skipAutomaticSelection={result.status !== "ready"}
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
        {result.status === "ready" && Object.keys(days).length === 0 && <p role="status">{labels.empty}</p>}
      </div>
      {(result.status === "loading" || (result.status === "ready" && times.length > 0)) && (
        <div className="border-subtle rtl:border-default flex h-full w-full flex-col overflow-x-auto px-5 py-3 pb-0 rtl:border-r ltr:md:border-l">
          {result.status === "loading" ? (
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
              <TimeSlotsHeader
                weekday={new Intl.DateTimeFormat(locale, { weekday: "short" }).format(
                  dayjs(selectedDate).toDate()
                )}
                day={dayjs(selectedDate).format("DD")}
                isToday={dayjs().isSame(dayjs(selectedDate), "day")}
                timeFormatToggle={timeFormatToggle}
              />
              <TimeSlots
                slots={times}
                timeZone={timeZone}
                timeFormat={timeFormat}
                onSelect={onTimeSelect}
                selectedSlots={selectedTime ? [selectedTime] : []}
              />
            </>
          )}
        </div>
      )}
    </Provider>
  );
}

export { BookingCalendar, type BookingCalendarProps };
