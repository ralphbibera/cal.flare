import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BookingCalendar } from "../../../src/components/BookingCalendar.tsx";
import "./candidate.css";

createRoot(document.getElementById("root")).render(
  (() => {
    function CalendarCase() {
      const [timeZone, setTimeZone] = useState("UTC");
      const [selected, setSelected] = useState();
      const [visible, setVisible] = useState(true);
      const [eventId, setEventId] = useState("default");
      const secondId = new URL(location.href).searchParams.get("eventId");
      return (
        <main className="mx-auto grid max-w-2xl md:grid-cols-2">
          <label>
            Event
            <select
              aria-label="Event"
              value={eventId}
              onChange={(event) => setEventId(event.currentTarget.value)}>
              <option value="default">Event A</option>
              {secondId && <option value={secondId}>Event B</option>}
            </select>
          </label>
          <label>
            Time zone
            <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
              <option>UTC</option>
              <option>Asia/Kolkata</option>
            </select>
          </label>
          {visible && (
            <BookingCalendar
              access={{ kind: "event", id: eventId }}
              locale="en-US"
              timeZone={timeZone}
              timeFormat="h:mma"
              labels={{
                today: "Today",
                previousMonth: "Previous month",
                nextMonth: "Next month",
                loading: "Loading availability",
                error: "Availability could not be loaded",
                retry: "Retry",
                empty: "No available times",
              }}
              selectedTime={selected}
              onTimeSelect={setSelected}
            />
          )}
          <button onClick={() => setVisible(false)}>Hide calendar</button>
          <output data-testid="selection">{selected ?? "none"}</output>
        </main>
      );
    }
    return <CalendarCase />;
  })()
);
