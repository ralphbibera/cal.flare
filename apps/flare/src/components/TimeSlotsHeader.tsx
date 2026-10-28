import type { ReactElement } from "react";
import { twMerge } from "tailwind-merge";

type Props = {
  weekday: string;
  day: string;
  isToday?: boolean;
  availableMonth?: string;
  timeFormatToggle?: ReactElement;
  customClassNames?: {
    availableTimeSlotsHeaderContainer?: string;
    availableTimeSlotsTitle?: string;
  };
};

export function TimeSlotsHeader({
  weekday,
  day,
  isToday,
  availableMonth,
  timeFormatToggle,
  customClassNames,
}: Props) {
  return (
    <header
      className={twMerge(
        "dark:bg-cal-muted dark:before:bg-cal-muted mb-3 flex w-full flex-row items-center font-medium",
        "bg-default before:bg-default",
        customClassNames?.availableTimeSlotsHeaderContainer
      )}>
      <span className="text-emphasis font-semibold">
        <span
          className={twMerge(
            isToday && !customClassNames?.availableTimeSlotsTitle && "!text-default",
            customClassNames?.availableTimeSlotsTitle
          )}>
          {weekday}
        </span>
        <span
          className={twMerge(
            "inline-flex items-center justify-center rounded-3xl px-1 pt-0.5 font-medium",
            `text-default text-sm ${customClassNames?.availableTimeSlotsTitle}`
          )}>
          {day}
          {availableMonth && `, ${availableMonth}`}
        </span>
      </span>
      {timeFormatToggle && <div className="ml-auto rtl:mr-auto">{timeFormatToggle}</div>}
    </header>
  );
}
