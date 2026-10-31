import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useEffect, useMemo, useState } from "react";
import type { Interval } from "../domain/scheduling.ts";
import { EARLIEST, isValidTimeZone, LATEST } from "../domain/scheduling.ts";
import type { CalendarAccess } from "./bookings.ts";
import { BookerClient } from "./bookings.ts";

dayjs.extend(utc);
dayjs.extend(timezone);
const client = new BookerClient();
type Days = Record<string, { time: string }[]>;
type Query = { month: string; timeZone: string; access?: CalendarAccess };
type Coverage = { from: number; to: number; horizon: number };
type AvailabilityPlan = { kind: "invalid" } | { kind: "empty" | "request"; coverage: Coverage };
type Result = { query: Query } & (
  | { status: "loading" | "error" }
  | { status: "ready"; days: Days; coverage: Coverage }
);

function planAvailability(query: Query, currentEpoch: number): AvailabilityPlan {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month) || !isValidTimeZone(query.timeZone))
    return { kind: "invalid" };
  const year = Number(query.month.slice(0, 4));
  const horizon = Math.max(EARLIEST, Math.min(currentEpoch + 365 * 86_400_000, LATEST));
  if (year < new Date(EARLIEST).getUTCFullYear() - 1 || year > new Date(LATEST).getUTCFullYear()) {
    const boundary = year < new Date(EARLIEST).getUTCFullYear() - 1 ? EARLIEST : horizon;
    return { kind: "empty", coverage: { from: boundary, to: boundary, horizon } };
  }
  const from = Math.min(Math.max(dayjs.tz(`${query.month}-01`, query.timeZone).valueOf(), EARLIEST), horizon);
  const endMonth = dayjs(`${query.month}-01`).add(2, "month").format("YYYY-MM-DD");
  const to = Math.max(from, Math.min(dayjs.tz(endMonth, query.timeZone).valueOf(), horizon));
  return { kind: from >= to ? "empty" : "request", coverage: { from, to, horizon } };
}

function calendarDays(slots: Interval[], timeZone: string): Days {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone,
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
    days[key] ??= [];
    days[key].push({ time: new Date(slot.start).toISOString() });
  }
  return days;
}

async function loadAvailability(
  query: Query,
  signal: AbortSignal,
  publish: (result: Result) => void
): Promise<void> {
  try {
    const plan = planAvailability(query, Date.now());
    if (plan.kind === "invalid") {
      publish({ query, status: "error" });
      return;
    }
    if (plan.kind === "empty") {
      publish({ query, status: "ready", days: {}, coverage: plan.coverage });
      return;
    }
    const { from, to } = plan.coverage;
    const slots = await client.calendarSlots(query.access, { from, to, timeZone: query.timeZone, signal });
    const days = calendarDays(slots, query.timeZone);
    publish({ query, status: "ready", days, coverage: plan.coverage });
  } catch {
    publish({ query, status: "error" });
  }
}

function useCalendarAvailability(month: string, timeZone: string, access?: CalendarAccess) {
  const id = access?.id,
    kind = access && "kind" in access ? access.kind : "attendee",
    token = access && "token" in access ? access.token : undefined;
  const query = useMemo(
    (): Query => ({
      month,
      timeZone,
      access:
        kind !== "attendee"
          ? { kind, id: id ?? "" }
          : id !== undefined || token !== undefined
            ? { id: id ?? "", token: token ?? "" }
            : undefined,
    }),
    [month, timeZone, id, token, kind]
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
    void loadAvailability(query, controller.signal, (next) => {
      if (!cancelled) setResult(next);
    });
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

export { useCalendarAvailability, type CalendarAccess };
