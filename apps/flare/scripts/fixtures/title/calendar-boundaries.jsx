import { createContext, useContext } from "react";
import strings from "../../../../../packages/i18n/locales/en/common.json";

export const CalendarReferenceContext = createContext(null);

function unavailable() {
  throw new Error("Calendar reference reached an unsupported path");
}

export function useLocale() {
  return { t: (key) => strings[key], i18n: { language: "en-US" }, isLocaleReady: true };
}
export function useEmbedStyles(key) {
  if (!["enabledDateButton", "disabledDateButton"].includes(key)) throw new Error("Unexpected embed style");
  return {};
}
export function useBookerStoreContext(selector) {
  const state = useContext(CalendarReferenceContext);
  if (state === null) return unavailable();
  return selector(state);
}
export function useTimePreferences(selector) {
  const state = useContext(CalendarReferenceContext);
  if (state === null) return unavailable();
  return selector(state);
}
export function useSlotsViewOnSmallScreen() {
  const state = useContext(CalendarReferenceContext);
  if (state === null) return unavailable();
  return state.slotsViewOnSmallScreen;
}
export const shallow = unavailable;
export const useIsEmbed = unavailable;
export default unavailable;
