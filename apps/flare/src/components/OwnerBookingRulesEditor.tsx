import { useEffect, useRef, useState } from "react";
import { BookerClient } from "../client/bookings.ts";
import type { BookingRules } from "../domain/settings.ts";
import { MAX_RESCHEDULE_NOTICE_MINUTES, parseBookingRules } from "../domain/settings.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";

type Labels = Record<
  | keyof BookingRules
  | "limitFutureBookings"
  | "windowHelp"
  | "limitRescheduling"
  | "heading"
  | "minutes"
  | "save"
  | "saved"
  | "invalid"
  | "failed"
  | "javascript",
  string
>;

const client = new BookerClient();
function readRulesForm(element: HTMLFormElement): BookingRules {
  const form = new FormData(element);
  return parseBookingRules({
    intervalMinutes: Number(form.get("intervalMinutes")),
    beforeMinutes: Number(form.get("beforeMinutes")),
    afterMinutes: Number(form.get("afterMinutes")),
    noticeMinutes: Number(form.get("noticeMinutes")),
    disableCancelling: form.get("disableCancelling") === "on",
    disableRescheduling: form.get("disableRescheduling") === "on",
    minimumRescheduleNotice: form.has("minimumRescheduleNotice")
      ? Number(form.get("minimumRescheduleNotice"))
      : null,
    bookingWindowDays: form.has("bookingWindowDays") ? Number(form.get("bookingWindowDays")) : null,
  });
}

export function OwnerBookingRulesEditor({
  eventId,
  rules,
  labels,
}: {
  eventId: string;
  rules: BookingRules;
  labels: Labels;
}) {
  const active = useRef(0);
  const locked = useRef(true);
  const [limited, setLimited] = useState(typeof rules.bookingWindowDays === "number");
  const [rescheduling, setRescheduling] = useState<"enabled" | "always" | "notice">(() => {
    if (rules.disableRescheduling) return "always";
    if (rules.minimumRescheduleNotice) return "notice";
    return "enabled";
  });
  const [notice, setNotice] = useState(String(rules.minimumRescheduleNotice || 60));
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "invalid" | "failed">(
    "loading"
  );
  useEffect(() => {
    locked.current = false;
    setStatus("idle");
    return () => {
      active.current++;
    };
  }, []);
  return (
    <section className="border-subtle border-t pt-6">
      <h2 id="owner-booking-rules-title" className="text-emphasis mb-4 font-semibold">
        {labels.heading}
      </h2>
      <form
        aria-labelledby="owner-booking-rules-title"
        action={`/api/owner/events/${eventId}/booking-rules`}
        method="post"
        onChange={() => {
          if (status !== "loading" && status !== "saving") setStatus("idle");
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (locked.current) return;
          let input: BookingRules;
          try {
            input = readRulesForm(event.currentTarget);
          } catch {
            setStatus("invalid");
            return;
          }
          locked.current = true;
          const ticket = ++active.current;
          setStatus("saving");
          try {
            await client.ownerSaveRules(eventId, input);
            if (ticket !== active.current) return;
            setStatus("saved");
          } catch {
            if (ticket !== active.current) return;
            setStatus("failed");
          } finally {
            locked.current = false;
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
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              name="disableCancelling"
              type="checkbox"
              defaultChecked={rules.disableCancelling}
            />
            {labels.disableCancelling}
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              name="disableRescheduling"
              type="checkbox"
              checked={rescheduling === "always"}
              onChange={(event) => setRescheduling(event.currentTarget.checked ? "always" : "enabled")}
            />
            {labels.disableRescheduling}
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              name="limitRescheduling"
              type="checkbox"
              checked={rescheduling === "notice"}
              onChange={(event) => setRescheduling(event.currentTarget.checked ? "notice" : "enabled")}
              aria-controls="booking-reschedule-notice"
            />
            {labels.limitRescheduling}
          </label>
          {rescheduling === "notice" && (
            <div>
              <Label htmlFor="booking-reschedule-notice">
                {labels.minimumRescheduleNotice} ({labels.minutes})
              </Label>
              <Input
                id="booking-reschedule-notice"
                name="minimumRescheduleNotice"
                type="number"
                required
                min={1}
                max={MAX_RESCHEDULE_NOTICE_MINUTES}
                step={1}
                value={notice}
                onChange={(event) => setNotice(event.currentTarget.value)}
              />
            </div>
          )}
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
