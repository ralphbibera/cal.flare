import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { twMerge } from "tailwind-merge";
import { Button } from "./Button.tsx";

dayjs.extend(utc);
dayjs.extend(timezone);

type TimeSlotsProps = {
  slots: { time: string }[];
  timeZone: string;
  timeFormat: "h:mma" | "HH:mm";
  selectedSlots?: string[];
  unavailableSlots?: string[];
  disabled?: boolean;
  className?: string;
  slotClassName?: string;
  onSelect: (time: string) => void;
};

function TimeSlots({
  slots,
  timeZone,
  timeFormat,
  selectedSlots = [],
  unavailableSlots = [],
  disabled = false,
  className,
  slotClassName,
  onSelect,
}: TimeSlotsProps) {
  return (
    <div className={twMerge("text-default flex flex-col", className)}>
      <div className="h-full pb-4">
        {slots.map(({ time }) => (
          <div key={time} className="flex gap-2">
            <Button
              disabled={disabled || unavailableSlots.includes(time)}
              data-testid="time"
              data-disabled={false}
              data-time={time}
              onClick={() => onSelect(time)}
              className={`hover:border-brand-default min-h-9 mb-2 flex h-auto w-full grow flex-col justify-center py-2 ${selectedSlots.includes(time) ? "border-brand-default" : ""} ${slotClassName}`}
              color="secondary">
              <div className="flex items-center gap-2">{dayjs.utc(time).tz(timeZone).format(timeFormat)}</div>
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export { TimeSlots, type TimeSlotsProps };
