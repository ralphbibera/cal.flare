import { createContext, useContext } from "react";

export const WeekPreferences = createContext(null);
export function useTimePreferences() {
  return useContext(WeekPreferences);
}
export function useRouter() {
  throw new Error("Week fixture does not navigate");
}
export const useCompatSearchParams = useRouter;
