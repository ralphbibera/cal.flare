import { useContext } from "react";
import { CalendarReferenceContext } from "./calendar-boundaries.jsx";

function unavailable() {
  throw new Error("The ordinary time-row reference reached an unsupported branch");
}
export function useBookerTime() {
  const state = useContext(CalendarReferenceContext);
  if (!state) return unavailable();
  return { timeFormat: state.timeFormat, timezone: state.timeZone };
}
export function useCheckOverlapWithOverlay() {
  return { isOverlapping: false };
}
export function getQueryParam(key) {
  return new URLSearchParams(location.search).get(key);
}
export const getPaymentAppData = unavailable;
export const useIsPlatform = unavailable;
export const CalendarX2Icon = unavailable;
export const OutOfOfficeInSlots = unavailable;
export const SeatsAvailabilityText = unavailable;
export const Root = unavailable;
export const Trigger = unavailable;
export const Portal = unavailable;
export const Content = unavailable;
