import { useEffect, useRef, useState } from "react";
import type { ScheduleCatalog } from "../client/bookings.ts";
import { BookerClient } from "../client/bookings.ts";
import { Button } from "./Button.tsx";
import { Label } from "./Label.tsx";
import type { scheduleLabels } from "./schedule-labels.ts";

export function OwnerScheduleAssignment({
  eventId,
  assignment,
  resolvedId,
  catalog,
  labels,
}: {
  eventId: string;
  assignment: string | null;
  resolvedId: string;
  catalog: ScheduleCatalog;
  labels: ReturnType<typeof scheduleLabels>["assignment"];
}) {
  const [desired, setDesired] = useState(assignment ?? "");
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "failed">("loading");
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    setStatus("idle");
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  const defaultName = catalog.schedules.find(({ id }) => id === catalog.defaultScheduleId)?.name;
  const currentName = catalog.schedules.find(
    ({ id }) => id === (assignment ?? catalog.defaultScheduleId)
  )?.name;
  return (
    <section className="space-y-3 border-subtle border-t pt-6">
      <h2 id="schedule-assignment-title" className="font-semibold">
        {labels.heading}
      </h2>
      <p className="break-words text-sm">
        {labels.current} {assignment === null ? `${labels.follow} (${defaultName})` : currentName}
      </p>
      <form
        aria-labelledby="schedule-assignment-title"
        onSubmit={async (event) => {
          event.preventDefault();
          if (request.current || !active.current) return;
          const controller = new AbortController();
          request.current = controller;
          setStatus("saving");
          try {
            await new BookerClient().ownerAssignSchedule(eventId, desired || null, controller.signal);
            if (active.current && !controller.signal.aborted) window.location.reload();
          } catch {
            if (active.current && !controller.signal.aborted) setStatus("failed");
          } finally {
            request.current = null;
          }
        }}>
        <fieldset disabled={status === "loading" || status === "saving"} className="min-w-0 space-y-3">
          <Label htmlFor="event-schedule">{labels.heading}</Label>
          <select
            id="event-schedule"
            className="block w-full min-w-0 rounded-md border border-default bg-default p-2 text-sm"
            value={desired}
            onChange={(event) => {
              setDesired(event.currentTarget.value);
              setStatus("idle");
            }}>
            <option value="">
              {labels.follow} ({defaultName})
            </option>
            {catalog.schedules.map(({ id, name }) => (
              <option key={id} value={id}>
                {name} ({id})
              </option>
            ))}
          </select>
          <p className="text-sm text-subtle">{labels.help}</p>
          <Button type="submit" loading={status === "saving"}>
            {labels.save}
          </Button>
        </fieldset>
        {status === "failed" && <p role="alert">{labels.failed}</p>}
      </form>
      <a className="block break-words underline" href={`/owner/schedules?scheduleId=${resolvedId}`}>
        {labels.manage}
      </a>
      <noscript>{labels.javascript}</noscript>
    </section>
  );
}
