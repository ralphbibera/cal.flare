import type { ComponentPropsWithRef } from "react";
import { twMerge } from "tailwind-merge";

type CalendarDayProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  day: number;
  active: boolean;
  isToday?: boolean;
  todayLabel: string;
  away?: boolean;
  emoji?: string | null;
  monthLabel?: string;
  customClassName?: { dayContainer?: string; dayActive?: string };
};

function CalendarDay({
  day,
  active,
  isToday,
  todayLabel,
  disabled,
  away,
  emoji,
  monthLabel,
  customClassName,
  ...props
}: CalendarDayProps) {
  return (
    <>
      {monthLabel !== undefined && (
        <div
          className={twMerge(
            "absolute top-0 z-10 mx-auto w-fit rounded-full font-semibold uppercase tracking-wide",
            active ? "text-white" : "text-default",
            disabled && "bg-emphasis"
          )}
          style={{ fontSize: "10px", lineHeight: "13px", padding: disabled ? "0 3px" : "3px 3px 3px 4px" }}>
          {monthLabel}
        </div>
      )}
      <button
        type="button"
        className={twMerge(
          "disabled:text-bookinglighter absolute bottom-0 left-0 right-0 top-0 mx-auto w-full cursor-pointer rounded-md border-2 border-transparent text-center text-sm font-medium transition disabled:cursor-default disabled:border-transparent disabled:font-light",
          active
            ? "bg-brand-default text-brand"
            : !disabled
              ? !customClassName?.dayActive
                ? "hover:border-brand-default text-emphasis bg-emphasis"
                : `hover:border-brand-default ${customClassName.dayActive}`
              : customClassName
                ? ""
                : "text-mute"
        )}
        data-testid="day"
        data-disabled={disabled}
        disabled={disabled}
        {...props}>
        {away && <span data-testid="away-emoji">{emoji}</span>}
        {!away && day}
        {isToday && (
          <span
            className={twMerge(
              "bg-brand-default absolute left-1/2 top-1/2 flex h-[5px] w-[5px] -translate-x-1/2 translate-y-[8px] items-center justify-center rounded-full align-middle sm:translate-y-[12px]",
              active && "bg-brand-accent"
            )}>
            <span className="sr-only">{todayLabel}</span>
          </span>
        )}
      </button>
    </>
  );
}

export { CalendarDay, type CalendarDayProps };
