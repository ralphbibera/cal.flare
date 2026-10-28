import * as ToggleGroup from "@radix-ui/react-toggle-group";
import type { CSSProperties } from "react";
import { twMerge } from "tailwind-merge";
import type { bookingLabels } from "./booking-labels.ts";

type TimeFormatToggleProps = {
  value: "h:mma" | "HH:mm";
  onChange: (value: "h:mma" | "HH:mm") => void;
  labels: Pick<typeof bookingLabels, "timeFormat" | "hour12" | "hour24">;
  customClassName?: string;
};
const shadow: CSSProperties & { "--toggle-group-shadow": string } = {
  "--toggle-group-shadow": "0px 2px 3px 0px rgba(0, 0, 0, 0.03), 0px 2px 2px -1px rgba(0, 0, 0, 0.03)",
};

export function TimeFormatToggle({ value, onChange, labels, customClassName }: TimeFormatToggleProps) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      defaultValue={value}
      orientation="horizontal"
      aria-label={labels.timeFormat}
      onValueChange={(next) => {
        if ((next === "h:mma" || next === "HH:mm") && next !== value) onChange(next);
      }}
      style={shadow}
      className={twMerge(
        "bg-muted rounded-[10px] p-0.5 inline-flex gap-0.5 rtl:flex-row-reverse",
        customClassName
      )}>
      {(["h:mma", "HH:mm"] as const).map((format) => (
        <ToggleGroup.Item
          key={format}
          value={format}
          className="aria-checked:bg-default aria-checked:border-subtle rounded-lg border border-transparent p-1.5 text-sm leading-none transition aria-checked:shadow-[0px_2px_3px_0px_rgba(0,0,0,0.03),0px_2px_2px_-1px_rgba(0,0,0,0.03)] text-default [&[aria-checked='false']]:hover:text-emphasis [&[aria-checked='false']]:hover:bg-subtle cursor-pointer">
          <div className="flex items-center gap-1 justify-center">
            {format === "h:mma" ? labels.hour12 : labels.hour24}
          </div>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
