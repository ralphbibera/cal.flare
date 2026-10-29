import dayjs from "dayjs";
import type { TimeSlotsProps } from "./TimeSlots.tsx";
import { TimeSlots } from "./TimeSlots.tsx";
import { TimeSlotsHeader } from "./TimeSlotsHeader.tsx";
import { TimeSlotsSkeleton } from "./TimeSlotsSkeleton.tsx";

type ColumnTimeSlotsProps = Pick<TimeSlotsProps, "timeZone" | "timeFormat" | "onSelect" | "selectedSlots"> & {
  days: Record<string, TimeSlotsProps["slots"]>;
  date: string;
  count: 2 | 6;
  locale: string;
  loading: boolean;
};

export function ColumnTimeSlots({ days, date, count, locale, loading, ...timeSlots }: ColumnTimeSlotsProps) {
  const anchor = dayjs(date);
  const dates = Object.keys(days)
    .filter((day) => days[day].length > 0 && dayjs(day).diff(anchor, "day") >= 0)
    .sort()
    .slice(0, count);
  return (
    <>
      <div className="flex">
        {loading ? (
          <div className="mb-3 h-8" />
        ) : (
          dates.map((day) => (
            <TimeSlotsHeader
              key={day}
              weekday={new Intl.DateTimeFormat(locale, { weekday: "short" }).format(dayjs(day).toDate())}
              day={dayjs(day).format("DD")}
              availableMonth={!anchor.isSame(dayjs(day), "month") ? dayjs(day).format("MMM") : undefined}
              customClassNames={{
                availableTimeSlotsHeaderContainer: `uppercase [&>span]:w-full [&>span]:text-center [&>span]:text-subtle [&>span]:text-xs [&>span]:font-medium ${dayjs().isSame(dayjs(day), "day") ? "[&>span>span:first-child]:text-default [&>span>span:last-child]:bg-brand-default [&>span>span:last-child]:text-brand [&>span>span:last-child]:ml-2" : ""}`,
                availableTimeSlotsTitle: "text-xs text-subtle",
              }}
            />
          ))
        )}
      </div>
      <div className="flex h-full w-full flex-row gap-4">
        {loading
          ? Array.from({ length: count + 1 }, (_, index) => <TimeSlotsSkeleton key={index} />)
          : dates.map((day) => (
              <div key={day} className="no-scrollbar overflow-x-hidden! h-full w-full overflow-y-auto">
                <TimeSlots {...timeSlots} slots={days[day]} />
              </div>
            ))}
      </div>
    </>
  );
}
