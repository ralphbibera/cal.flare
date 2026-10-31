import { useEffect, useRef, useState } from "react";
import { BookerClient } from "../client/bookings.ts";
import type { ScheduleOverrides } from "../domain/settings.ts";
import { parseScheduleOverrides } from "../domain/settings.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";

type Range = { id: string; start: string; end: string };
type Row = { id: string; date: string; ranges: Range[] };
type Labels = Record<
  | "heading"
  | "date"
  | "interval"
  | "start"
  | "end"
  | "addDate"
  | "add"
  | "remove"
  | "delete"
  | "save"
  | "saved"
  | "invalid"
  | "failed"
  | "help"
  | "empty"
  | "closed"
  | "midnight"
  | "javascript",
  string
>;
function clock(minute: number): string {
  return `${String(Math.floor((minute % 1440) / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function minutes(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

export function OwnerOverridesEditor({
  overrides,
  scheduleId,
  labels,
  onSaving,
}: ScheduleOverrides & { scheduleId: string; labels: Labels; onSaving?: (saving: boolean) => void }) {
  const endpoint = `/api/owner/schedules/${scheduleId}/overrides`;
  const [rows, setRows] = useState<Row[]>(() =>
    overrides.map((override, index) => ({
      id: `override-${index}`,
      date: override.date,
      ranges: override.ranges.map((range, i) => ({
        id: `override-${index}-range-${i}`,
        start: clock(range.startMinute),
        end: clock(range.endMinute),
      })),
    }))
  );
  const nextId = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const active = useRef(false);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "invalid" | "failed">(
    "loading"
  );
  useEffect(() => {
    active.current = true;
    setStatus("idle");
    return () => {
      active.current = false;
      pending.current?.abort();
    };
  }, []);
  function update(id: string, change: Partial<Pick<Row, "date" | "ranges">>): void {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
    setStatus("idle");
  }
  return (
    <section className="border-subtle border-t pt-6">
      <h2 id="owner-overrides-title" className="text-emphasis mb-4 font-semibold">
        {labels.heading}
      </h2>
      <form
        aria-labelledby="owner-overrides-title"
        action={endpoint}
        method="post"
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current || !active.current) return;
          let input: ScheduleOverrides;
          try {
            input = parseScheduleOverrides({
              overrides: rows.map((row) => ({
                date: row.date,
                ranges: row.ranges.map((range) => ({
                  startMinute: minutes(range.start),
                  endMinute: minutes(range.end) === 0 ? 1440 : minutes(range.end),
                })),
              })),
            });
          } catch {
            setStatus("invalid");
            return;
          }
          const controller = new AbortController();
          pending.current = controller;
          onSaving?.(true);
          setStatus("saving");
          try {
            await new BookerClient().ownerScheduleOverrides(scheduleId, input, controller.signal);
            if (!controller.signal.aborted) setStatus("saved");
          } catch {
            if (!controller.signal.aborted) setStatus("failed");
          } finally {
            pending.current = null;
            if (active.current) onSaving?.(false);
          }
        }}>
        <fieldset disabled={status === "loading" || status === "saving"} className="min-w-0 space-y-4">
          <p className="text-subtle text-sm">{labels.help}</p>
          <p className="text-subtle text-sm">{labels.midnight}</p>
          {rows.length === 0 && <p className="text-subtle text-sm">{labels.empty}</p>}
          {rows.map((row, index) => (
            <fieldset key={row.id} className="border-subtle min-w-0 space-y-3 rounded-md border p-3">
              <legend className="px-1 text-sm">
                {labels.date} {index + 1}
              </legend>
              <Label htmlFor={`${row.id}-date`}>{labels.date}</Label>
              <Input
                id={`${row.id}-date`}
                className="min-w-0"
                type="date"
                required
                value={row.date}
                onChange={(event) => update(row.id, { date: event.currentTarget.value })}
              />
              {row.ranges.length === 0 && <p className="text-subtle text-sm">{labels.closed}</p>}
              {row.ranges.map((range, i) => (
                <fieldset key={range.id} className="min-w-0 space-y-2">
                  <legend className="text-sm">
                    {labels.interval} {i + 1}
                  </legend>
                  <div className="grid grid-cols-2 gap-2">
                    {(["start", "end"] as const).map((key) => (
                      <div key={key} className="min-w-0">
                        <Label htmlFor={`${range.id}-${key}`}>{labels[key]}</Label>
                        <Input
                          id={`${range.id}-${key}`}
                          className="min-w-0"
                          type="time"
                          required
                          step={60}
                          value={range[key]}
                          onChange={(event) =>
                            update(row.id, {
                              ranges: row.ranges.map((item) =>
                                item.id === range.id ? { ...item, [key]: event.currentTarget.value } : item
                              ),
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <Button
                    color="minimal"
                    onClick={() =>
                      update(row.id, { ranges: row.ranges.filter((item) => item.id !== range.id) })
                    }>
                    {labels.remove}
                  </Button>
                </fieldset>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  color="secondary"
                  disabled={row.ranges.length >= 100}
                  onClick={() => {
                    const id = `override-new-${nextId.current++}`;
                    update(row.id, { ranges: [...row.ranges, { id, start: "09:00", end: "17:00" }] });
                  }}>
                  {labels.add}
                </Button>
                <Button
                  color="minimal"
                  onClick={() => {
                    setRows((current) => current.filter((item) => item.id !== row.id));
                    setStatus("idle");
                  }}>
                  {labels.delete}
                </Button>
              </div>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              color="secondary"
              disabled={rows.length >= 366}
              onClick={() => {
                const id = `override-new-${nextId.current++}`;
                setRows((current) => [...current, { id, date: "", ranges: [] }]);
                setStatus("idle");
              }}>
              {labels.addDate}
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
