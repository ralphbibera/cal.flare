import strings from "../../../../../packages/i18n/locales/en/common.json";

function unavailable() {
  throw new Error("The isolated calendar-day reference must not execute calendar orchestration");
}

export function useLocale() {
  return { t: (key) => strings[key] };
}
export function useEmbedStyles(key) {
  if (!["enabledDateButton", "disabledDateButton"].includes(key)) throw new Error("Unexpected embed style");
  return {};
}
export const useSlotsViewOnSmallScreen = unavailable;
export const useBookerStoreContext = unavailable;
export const getAvailableDatesInMonth = unavailable;
export const daysInMonth = unavailable;
export const yyyymmdd = unavailable;
export const weekdayNames = unavailable;
export const Button = unavailable;
export const SkeletonText = unavailable;
export const Tooltip = unavailable;
export const shallow = unavailable;
export default unavailable;
