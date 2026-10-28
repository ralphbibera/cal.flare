import strings from "../../../../../packages/i18n/locales/en/common.json";

function unavailable() {
  throw new Error("Metadata block reference reached an unsupported event-details branch");
}
export const EventDetailBlocks = {};
export const useBookerStore = unavailable;
export const Price = unavailable;
export const PriceIcon = unavailable;
export const AvailableEventLocations = unavailable;
export const EventDuration = unavailable;
export const EventOccurences = unavailable;
export const useShouldShowArrows = unavailable;

export function translateDuration(key, { count, unit }) {
  if (!["minute_one_short", "hour_one_short", "multiple_duration_timeUnit_short"].includes(key))
    throw new Error("Unexpected duration translation");
  return strings[key]
    .replace("{{count}}", String(count))
    .replace("$t({{unit}}_short)", strings[`${unit}_short`] || "");
}
export function durationText(count, unit) {
  return translateDuration(count === 1 ? `${unit}_one_short` : "multiple_duration_timeUnit_short", {
    count,
    unit,
  });
}
