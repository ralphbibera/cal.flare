import { useEffect, useRef, useState } from "react";
import type { WeeklySchedule } from "../domain/settings.ts";
import { parseWeeklySchedule } from "../domain/settings.ts";
import { Button } from "./Button.tsx";

type Row = { id: string; weekday: string; start: string; end: string };
type Labels = Record<
  | "heading"
  | "zone"
  | "day"
  | "interval"
  | "start"
  | "end"
  | "add"
  | "remove"
  | "save"
  | "saved"
  | "invalid"
  | "failed"
  | "midnight"
  | "empty"
  | "javascript",
  string
> & { weekdays: string[] };
function clock(minute: number): string {
  return `${String(Math.floor((minute % 1440) / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function minutes(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

export function OwnerScheduleEditor({ schedule, labels }: { schedule: WeeklySchedule; labels: Labels }) {
  const [rows, setRows] = useState<Row[]>(() =>
    schedule.rules.map((rule, index) => ({
      id: `range-${index}`,
      weekday: String(rule.weekday),
      start: clock(rule.startMinute),
      end: clock(rule.endMinute),
    }))
  );
  const nextId = useRef(rows.length);
  const [zones, setZones] = useState([schedule.timeZone]);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "invalid" | "failed">(
    "loading"
  );
  useEffect(() => {
    setZones([...new Set(["UTC", schedule.timeZone, ...Intl.supportedValuesOf("timeZone")])]);
    setStatus("idle");
  }, [schedule.timeZone]);
  function update(id: string, field: "weekday" | "start" | "end", value: string): void {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }
  const field =
    "bg-default border-default text-default block w-full min-w-0 rounded-md border px-2 py-2 text-sm";
  return (
    <section className="border-subtle border-t pt-6">
      <h2 id="owner-schedule-title" className="text-emphasis mb-4 font-semibold">
        {labels.heading}
      </h2>
      <form
        aria-labelledby="owner-schedule-title"
        action="/api/owner/schedule"
        method="post"
        onChange={() => {
          if (status !== "saving" && status !== "loading") setStatus("idle");
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          let weekly: WeeklySchedule;
          try {
            weekly = parseWeeklySchedule({
              timeZone: form.get("timeZone"),
              rules: rows.map((row) => ({
                weekday: Number(row.weekday),
                startMinute: minutes(row.start),
                endMinute: minutes(row.end) === 0 ? 1440 : minutes(row.end),
              })),
            });
          } catch {
            setStatus("invalid");
            return;
          }
          setStatus("saving");
          try {
            const response = await fetch("/api/owner/schedule", {
              method: "PATCH",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(weekly),
            });
            const result: unknown = await response.json();
            if (
              !response.ok ||
              typeof result !== "object" ||
              result === null ||
              !("saved" in result) ||
              result.saved !== true
            )
              throw new Error();
            setStatus("saved");
          } catch {
            setStatus("failed");
          }
        }}>
        <fieldset disabled={status === "loading" || status === "saving"} className="min-w-0 space-y-4">
          <label className="block text-sm" htmlFor="schedule-time-zone">
            {labels.zone}
          </label>
          <select id="schedule-time-zone" className={field} name="timeZone" defaultValue={schedule.timeZone}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <p className="text-subtle text-sm">{labels.midnight}</p>
          {rows.length === 0 && <p className="text-subtle text-sm">{labels.empty}</p>}
          {rows.map((row, index) => (
            <fieldset key={row.id} className="border-subtle min-w-0 space-y-3 rounded-md border p-3">
              <legend className="px-1 text-sm">
                {labels.interval} {index + 1}
              </legend>
              <label className="block text-sm" htmlFor={`${row.id}-day`}>
                {labels.day}
              </label>
              <select
                id={`${row.id}-day`}
                className={field}
                value={row.weekday}
                onChange={(event) => update(row.id, "weekday", event.currentTarget.value)}>
                {labels.weekdays.map((day, weekday) => (
                  <option key={day} value={weekday}>
                    {day}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0">
                  <label className="block text-sm" htmlFor={`${row.id}-start`}>
                    {labels.start}
                  </label>
                  <input
                    id={`${row.id}-start`}
                    className={field}
                    type="time"
                    required
                    step={60}
                    value={row.start}
                    onChange={(event) => update(row.id, "start", event.currentTarget.value)}
                  />
                </div>
                <div className="min-w-0">
                  <label className="block text-sm" htmlFor={`${row.id}-end`}>
                    {labels.end}
                  </label>
                  <input
                    id={`${row.id}-end`}
                    className={field}
                    type="time"
                    required
                    step={60}
                    value={row.end}
                    onChange={(event) => update(row.id, "end", event.currentTarget.value)}
                  />
                </div>
              </div>
              <Button
                color="minimal"
                onClick={() => {
                  setRows((current) => current.filter((item) => item.id !== row.id));
                  setStatus("idle");
                }}>
                {labels.remove}
              </Button>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              color="secondary"
              disabled={rows.length >= 28}
              onClick={() => {
                const id = `range-${nextId.current++}`;
                setRows((current) => [...current, { id, weekday: "0", start: "09:00", end: "17:00" }]);
                setStatus("idle");
              }}>
              {labels.add}
            </Button>
            <Button type="submit" loading={status === "saving"}>
              {labels.save}
            </Button>
          </div>
        </fieldset>
        {status === "saved" && (
          <p role="status" className="mt-4 text-sm">
            {labels.saved}
          </p>
        )}
        {(status === "invalid" || status === "failed") && (
          <p role="alert" className="mt-4 text-sm">
            {labels[status]}
          </p>
        )}
        <noscript>
          <p className="mt-4 text-sm">{labels.javascript}</p>
        </noscript>
      </form>
    </section>
  );
}
