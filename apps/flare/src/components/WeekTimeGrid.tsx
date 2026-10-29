import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useEffect, useRef, useState } from "react";
import type { TimeSlotsProps } from "./TimeSlots.tsx";
import "./WeekTimeGrid.css";

dayjs.extend(utc);
dayjs.extend(timezone);

type WeekTimeGridProps = Pick<TimeSlotsProps, "timeZone" | "timeFormat" | "onSelect"> & {
  date: string;
  count: 4 | 7;
  duration: number;
  locale?: string;
} & (
    | { status: "ready"; days: Record<string, TimeSlotsProps["slots"]> }
    | { status: "loading" | "error"; days?: never }
  );

export function WeekTimeGrid(props: WeekTimeGridProps) {
  const { date, count, duration, timeZone, timeFormat, locale = "en-US", onSelect } = props;
  const currentLine = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => dayjs().tz(timeZone));
  useEffect(() => {
    setNow(dayjs().tz(timeZone));
  }, [timeZone]);
  useEffect(() => {
    const timer = setTimeout(() => currentLine.current?.scrollIntoView({ block: "center" }), 100);
    return () => clearTimeout(timer);
  }, []);
  const dates = Array.from({ length: count }, (_, offset) => dayjs.utc(date).add(offset, "day"));
  const hours = Array.from({ length: 25 }, (_, hour) => dayjs.utc(date).hour(hour).minute(0));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const accessibleDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeZone,
  });

  return (
    <div className="week-time-grid flex h-full w-full flex-col">
      {props.status === "loading" && (
        <div className="fixed left-[calc(50%+calc(var(--booker-meta-width,0px)/2))] top-1/2 z-80 h-10 w-10 -translate-x-1/2 -translate-y-1/2">
          <svg
            role="presentation"
            className="h-10 w-10"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg">
            <path
              className="fill-default"
              d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,19a8,8,0,1,1,8-8A8,8,0,0,1,12,20Z"
              opacity=".25"
            />
            <path
              className="animate-spinning fill-emphasis origin-center"
              d="M10.14,1.16a11,11,0,0,0-9,8.92A1.59,1.59,0,0,0,2.46,12,1.52,1.52,0,0,0,4.11,10.7a8,8,0,0,1,6.66-6.61A1.42,1.42,0,0,0,12,2.69h0A1.57,1.57,0,0,0,10.14,1.16Z"
            />
          </svg>
        </div>
      )}
      <div className="bg-default dark:bg-cal-muted relative isolate flex h-full flex-auto flex-col">
        <div
          style={{ width: "165%" }}
          className="flex max-w-full flex-none flex-col sm:max-w-none md:max-w-full">
          <div className="bg-default dark:bg-cal-muted top-(--calendar-dates-sticky-offset,0px) z-80 sticky flex-none border-b border-b-default border-r-default border-r">
            <div className="text-subtle -mr-px flex auto-cols-fr leading-6">
              <div className="col-end-1 flex w-16 items-center justify-center border-l-default border-l" />
              {dates.map((day) => {
                const today = dayjs().format("YYYY-MM-DD") === day.format("YYYY-MM-DD");
                return (
                  <div
                    key={day.toISOString()}
                    className={`flex flex-1 items-center justify-center py-3 text-xs font-medium uppercase ${today ? "text-default" : ""}`}>
                    <span>
                      {weekday.format(day.toDate())}{" "}
                      <span
                        className={`items-center justify-center p-1 ${today ? "bg-brand-default text-brand ml-1 rounded-md" : ""}`}>
                        {day.format("DD")}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="relative flex flex-auto">
            <div
              ref={currentLine}
              className="absolute z-70 flex h-px items-center justify-center text-xs"
              aria-hidden="true"
              style={{ top: ((now.hour() * 60 + now.minute()) * 58) / 60 + 28 }}>
              <div className="w-16 pr-2 text-right">{dayjs().tz(timeZone).format(timeFormat)}</div>
              <div className="bg-inverted h-3 w-px" />
              <div className="bg-inverted h-px w-screen" />
            </div>
            <div className="bg-default dark:bg-cal-muted ring-muted sticky left-0 z-10 w-16 flex-none ring-1 border-default border-l border-r" />
            <div className="week-time-grid-pattern grid flex-auto grid-cols-1 grid-rows-1">
              <div
                className="pointer-events-none relative z-60 col-start-1 col-end-2 row-start-1 grid divide-y divide-default"
                style={{ gridTemplateRows: "repeat(24, minmax(58px,1fr))" }}>
                <div className="row-end-1 h-7" />
                {hours.map((hour) => (
                  <div key={hour.toISOString()}>
                    <div className="text-muted sticky left-0 z-20 -ml-14 -mt-2.5 w-14 pr-2 text-right text-xs leading-5 rtl:-mr-14">
                      {hour.format(timeFormat)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="pointer-events-none relative z-60 col-start-1 col-end-2 row-start-1 grid auto-cols-auto grid-rows-1 divide-x divide-default">
                {dates.map((day, index) => (
                  <div
                    key={day.toISOString()}
                    className="row-span-full"
                    style={{ gridColumnStart: index + 1 }}
                  />
                ))}
              </div>
              <ol
                className="col-start-1 col-end-2 row-start-1 grid auto-cols-auto text-[0px]"
                style={{ marginTop: 28 }}>
                {dates.map((day, index) => (
                  <li key={day.toISOString()} className="relative" style={{ gridColumnStart: index + 1 }}>
                    {(props.status === "ready" ? props.days[day.format("YYYY-MM-DD")] || [] : []).map(
                      ({ time }) => {
                        const local = dayjs.utc(time).tz(timeZone);
                        return (
                          <button
                            key={time}
                            type="button"
                            data-testid="calendar-empty-cell"
                            data-slot={time}
                            data-disabled={false}
                            aria-label={`${accessibleDate.format(local.toDate())}, ${local.format(timeFormat)}, ${timeZone} UTC${local.format("Z")}`}
                            className="week-time-grid-slot group bg-default dark:bg-cal-muted absolute flex w-[calc(100%-1px)] items-center justify-center"
                            style={{
                              height: (duration * 58) / 60,
                              overflow: "visible",
                              top: ((local.hour() * 60 + local.minute()) * 58) / 60,
                            }}
                            onClick={() => onSelect(time)}>
                            <div
                              className={`bg-brand-default hover:bg-brand-default text-brand dark:border-emphasis absolute hidden rounded-[4px] p-[6px] text-xs font-semibold leading-5 group-hover:flex group-hover:cursor-pointer group-focus-visible:flex ${duration > 15 ? "items-start pt-3" : duration < 15 ? "items-center" : ""}`}
                              style={{
                                height: (duration * 58) / 60 - 2,
                                zIndex: 80,
                                width: "calc(100% - 2px)",
                              }}>
                              <div className="text-ellipsis leading-0">{local.format(timeFormat)}</div>
                            </div>
                          </button>
                        );
                      }
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
