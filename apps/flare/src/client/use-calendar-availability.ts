import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useEffect, useMemo, useState } from "react";
import { EARLIEST, isValidTimeZone, LATEST } from "../domain/scheduling.ts";
import type { BookingAccess } from "./bookings.ts";
import { BookerClient } from "./bookings.ts";

dayjs.extend(utc);
dayjs.extend(timezone);
const client = new BookerClient();
type Days = Record<string, { time: string }[]>;
type Query = { month: string; timeZone: string; access?: BookingAccess };
type Result = { query: Query } & ({ status: "loading" | "error" } | { status: "ready"; days: Days });

function useCalendarAvailability(month: string, timeZone: string, access?: BookingAccess) {
  const id = access?.id,
    token = access?.token;
  const query = useMemo(
    () => ({
      month,
      timeZone,
      access: id !== undefined || token !== undefined ? { id: id ?? "", token: token ?? "" } : undefined,
    }),
    [month, timeZone, id, token]
  );
  const [result, setResult] = useState<Result>({ query, status: "loading" });
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setResult((previous) =>
      previous.query === query && previous.status === "ready" ? previous : { query, status: "loading" }
    );
    async function load() {
      try {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month) || !isValidTimeZone(query.timeZone)) {
          if (!cancelled) setResult({ query, status: "error" });
          return;
        }
        const year = Number(query.month.slice(0, 4));
        if (year < new Date(EARLIEST).getUTCFullYear() - 1 || year > new Date(LATEST).getUTCFullYear()) {
          if (!cancelled) setResult({ query, status: "ready", days: {} });
          return;
        }
        const from = Math.max(dayjs.tz(`${query.month}-01`, query.timeZone).valueOf(), EARLIEST);
        const endMonth = dayjs(`${query.month}-01`).add(2, "month").format("YYYY-MM-DD");
        const to = Math.min(
          dayjs.tz(endMonth, query.timeZone).valueOf(),
          Date.now() + 365 * 86_400_000,
          LATEST
        );
        const slots =
          from < to
            ? await client.slots({
                from,
                to,
                timeZone: query.timeZone,
                access: query.access,
                signal: controller.signal,
              })
            : [];
        const formatter = new Intl.DateTimeFormat("en", {
          timeZone: query.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          calendar: "gregory",
          numberingSystem: "latn",
        });
        const days: Days = {};
        for (const slot of slots) {
          const fields = Object.fromEntries(
            formatter.formatToParts(slot.start).map((part) => [part.type, part.value])
          );
          const key = `${fields.year}-${fields.month}-${fields.day}`;
          (days[key] ??= []).push({ time: new Date(slot.start).toISOString() });
        }
        if (!cancelled) setResult({ query, status: "ready", days });
      } catch {
        if (!cancelled) setResult({ query, status: "error" });
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query, revision]);
  useEffect(() => {
    const refreshOnFocus = () => setRevision((value) => value + 1);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshOnFocus();
    }, 300_000);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, []);
  const current: Result = result.query === query ? result : { query, status: "loading" };
  return { result: current, refresh };
}

export { useCalendarAvailability };
