import { useEffect, useState } from "react";
import type { BookingRules } from "../domain/settings.ts";
import { parseBookingRules } from "../domain/settings.ts";
import { Button } from "./Button.tsx";

type Labels = Record<
  keyof BookingRules | "heading" | "minutes" | "save" | "saved" | "invalid" | "failed" | "javascript",
  string
>;

export function OwnerBookingRulesEditor({ rules, labels }: { rules: BookingRules; labels: Labels }) {
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "invalid" | "failed">(
    "loading"
  );
  useEffect(() => setStatus("idle"), []);
  return (
    <section className="border-subtle border-t pt-6">
      <h2 id="owner-booking-rules-title" className="text-emphasis mb-4 font-semibold">
        {labels.heading}
      </h2>
      <form
        aria-labelledby="owner-booking-rules-title"
        action="/api/owner/booking-rules"
        method="post"
        onChange={() => {
          if (status !== "loading" && status !== "saving") setStatus("idle");
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          let input: BookingRules;
          try {
            input = parseBookingRules({
              intervalMinutes: Number(form.get("intervalMinutes")),
              beforeMinutes: Number(form.get("beforeMinutes")),
              afterMinutes: Number(form.get("afterMinutes")),
              noticeMinutes: Number(form.get("noticeMinutes")),
              disableCancelling: form.get("disableCancelling") === "on",
              disableRescheduling: form.get("disableRescheduling") === "on",
            });
          } catch {
            setStatus("invalid");
            return;
          }
          setStatus("saving");
          try {
            const response = await fetch("/api/owner/booking-rules", {
              method: "PATCH",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
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
          {(
            [
              ["intervalMinutes", 5, 240],
              ["beforeMinutes", 0, 120],
              ["afterMinutes", 0, 120],
              ["noticeMinutes", 0, 43200],
            ] as const
          ).map(([key, min, max]) => (
            <div key={key}>
              <label className="block text-sm" htmlFor={`booking-rules-${key}`}>
                {labels[key]} ({labels.minutes})
              </label>
              <input
                id={`booking-rules-${key}`}
                className="bg-default border-default text-default mt-1 block w-full min-w-0 rounded-md border px-3 py-2 text-sm"
                name={key}
                type="number"
                defaultValue={rules[key]}
                required
                min={min}
                max={max}
                step={1}
              />
            </div>
          ))}
          {(["disableCancelling", "disableRescheduling"] as const).map((key) => (
            <label key={key} className="flex items-start gap-2 text-sm">
              <input className="mt-1" name={key} type="checkbox" defaultChecked={rules[key]} />
              {labels[key]}
            </label>
          ))}
          <Button type="submit" loading={status === "saving"}>
            {labels.save}
          </Button>
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
