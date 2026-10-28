import { twMerge } from "tailwind-merge";

type Props = {
  weekday: string;
  day: string;
  isToday?: boolean;
  availableMonth?: string;
  customClassNames?: {
    availableTimeSlotsHeaderContainer?: string;
    availableTimeSlotsTitle?: string;
  };
};

export function TimeSlotsHeader({ weekday, day, isToday, availableMonth, customClassNames }: Props) {
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
    </header>
  );
}
