import { useEffect, useState } from "react";
import type { BookingRules } from "../domain/settings.ts";
import { parseBookingRules } from "../domain/settings.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";

type Labels = Record<
  | keyof BookingRules
  | "limitFutureBookings"
  | "windowHelp"
  | "heading"
  | "minutes"
  | "save"
  | "saved"
  | "invalid"
  | "failed"
  | "javascript",
  string
>;

export function OwnerBookingRulesEditor({ rules, labels }: { rules: BookingRules; labels: Labels }) {
  const [limited, setLimited] = useState(typeof rules.bookingWindowDays === "number");
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
              bookingWindowDays: limited ? Number(form.get("bookingWindowDays")) : null,
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
              <Label htmlFor={`booking-rules-${key}`}>
                {labels[key]} ({labels.minutes})
              </Label>
              <Input
                id={`booking-rules-${key}`}
                className="min-w-0"
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
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              name="limitFutureBookings"
              type="checkbox"
              checked={limited}
              onChange={(event) => setLimited(event.currentTarget.checked)}
              aria-controls="booking-window-days"
            />
            {labels.limitFutureBookings}
          </label>
          {limited && (
            <div>
              <Label htmlFor="booking-window-days">{labels.bookingWindowDays}</Label>
              <Input
                id="booking-window-days"
                name="bookingWindowDays"
                type="number"
                defaultValue={rules.bookingWindowDays ?? 30}
                required
                min={1}
                max={365}
                step={1}
                aria-describedby="booking-window-help"
              />
              <p id="booking-window-help" className="text-subtle mt-2 text-sm">
                {labels.windowHelp}
              </p>
            </div>
          )}
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
