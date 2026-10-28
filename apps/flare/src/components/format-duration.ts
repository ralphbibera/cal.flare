export function formatDuration(
  minutes: number | undefined,
  translate: (count: number, unit: "minute" | "hour") => string
): string | null {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const minuteLabel = remainder > 0 ? translate(remainder, "minute") : "";
  const hourLabel = hours > 0 ? translate(hours, "hour") : "";
  if (hourLabel && minuteLabel) return `${hourLabel} ${minuteLabel}`;
  return hourLabel || minuteLabel;
}
