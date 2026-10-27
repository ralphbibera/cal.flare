import { useEffect, useState } from "react";
import type { PublicBooking } from "../client/bookings.ts";
import { BookingCalendar, type BookingCalendarProps } from "./BookingCalendar.tsx";
import { Button } from "./Button.tsx";
import { EventTitle } from "./EventTitle.tsx";
import { Icon } from "./Icon.tsx";

type PublicBookerProps = Pick<PublicBooking, "organizer" | "event"> & {
  labels: BookingCalendarProps["labels"] & {
    timeZone: string;
    timeFormat: string;
    hour12: string;
    hour24: string;
    selectedTime: string;
    minutes: string;
  };
};

export function PublicBooker({ organizer, event, labels }: PublicBookerProps) {
  const [timeZone, setTimeZone] = useState("UTC");
  const [zones, setZones] = useState(["UTC"]);
  const [format, setFormat] = useState<"h:mma" | "HH:mm">("h:mma");
  const [selected, setSelected] = useState<string>();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setZones([...new Set(["UTC", local, ...Intl.supportedValuesOf("timeZone")])]);
    setTimeZone(local);
    setHydrated(true);
  }, []);
  const selectedLabel = selected
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone,
        hour12: format === "h:mma",
      }).format(new Date(selected))
    : undefined;
  return (
    <main className="main text-default my-20 flex min-h-full w-full flex-col items-center overflow-visible">
      <div
        data-testid="booker-container"
        className="bg-default border-subtle dark:bg-cal-muted grid w-full max-w-full items-start rounded-md border [--booker-main-width:480px] [--booker-meta-width:240px] [--booker-timeslots-width:240px] md:w-auto md:grid-cols-[var(--booker-meta-width)_minmax(0,var(--booker-main-width))_var(--booker-timeslots-width)] lg:[--booker-meta-width:280px] lg:[--booker-timeslots-width:280px] [&>[aria-busy]]:w-auto">
        <section className="relative z-10 p-6" data-testid="event-meta">
          <p className="text-subtle text-sm font-medium">{organizer.name}</p>
          <EventTitle className="my-2">{event.title}</EventTitle>
          {event.description && (
            <p className="mb-8 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words text-sm">
              {event.description}
            </p>
          )}
          <div className="space-y-4 text-sm font-medium">
            <p className="flex items-start">
              <Icon name="clock" className="mr-2 mt-0.5 size-4 shrink-0" />
              {labels.minutes.replace("{{count}}", String(event.durationMinutes))}
            </p>
            <div className="flex items-start">
              <Icon name="globe" className="mr-2 mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <label htmlFor="booker-time-zone" className="sr-only">
                  {labels.timeZone}
                </label>
                <select
                  id="booker-time-zone"
                  className="bg-default w-full min-w-0 text-sm"
                  value={timeZone}
                  onChange={(change) => {
                    setTimeZone(change.target.value);
                    setSelected(undefined);
                  }}>
                  {zones.map((zone) => (
                    <option key={zone}>{zone}</option>
                  ))}
                </select>
              </span>
            </div>
            <div className="flex gap-1" role="group" aria-label={labels.timeFormat}>
              {(["h:mma", "HH:mm"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  color="secondary"
                  aria-pressed={format === value}
                  onClick={() => setFormat(value)}>
                  {value === "h:mma" ? labels.hour12 : labels.hour24}
                </Button>
              ))}
            </div>
            {selected && (
              <p role="status">
                {labels.selectedTime}
                <br />
                <time dateTime={selected}>{selectedLabel}</time>
              </p>
            )}
          </div>
        </section>
        {hydrated ? (
          <BookingCalendar
            locale="en-US"
            timeZone={timeZone}
            timeFormat={format}
            labels={labels}
            selectedTime={selected}
            onTimeSelect={setSelected}
          />
        ) : (
          <p role="status">{labels.loading}</p>
        )}
      </div>
    </main>
  );
}
