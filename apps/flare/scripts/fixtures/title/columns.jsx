import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CalendarReferenceContext } from "./calendar-boundaries.jsx";

const params = new URLSearchParams(location.search);
const candidate = params.has("candidate");
const scenario = params.get("case") || "initial";
let Columns;
if (candidate) {
  await import("./candidate.css");
  Columns = (await import("../../../src/components/ColumnTimeSlots.tsx")).ColumnTimeSlots;
} else {
  await import("../../../../web/styles/globals.css");
  const { default: inter } = await import("../../../../web/public/fonts/Inter-roman.var.woff2?url");
  const fonts = document.createElement("style");
  fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
  document.head.append(fonts);
  const { AvailableTimeSlots } = await import(
    "../../../../web/modules/bookings/components/AvailableTimeSlots.tsx"
  );
  Columns = ({ days, date, count, loading, onSelect, timeZone, timeFormat }) => (
    <CalendarReferenceContext.Provider
      value={{
        selectedDate: date,
        layout: "column_view",
        timeZone,
        timeFormat,
        bookingData: null,
        selectedTimeslot: null,
        tentativeSelectedTimeslots: [],
        setTentativeSelectedTimeslots: () => {},
        setSeatedEventData: () => {
          throw new Error("Unexpected seated event");
        },
      }}>
      <AvailableTimeSlots
        schedule={{
          data: { slots: days },
          invalidate: () => {
            throw new Error("Unexpected invalidation");
          },
        }}
        extraDays={count}
        isLoading={loading}
        event={{ data: { price: 0, length: 30 } }}
        loadingStates={{ creatingBooking: false }}
        unavailableTimeSlots={[]}
        onAvailableTimeSlotSelect={onSelect}
      />
    </CalendarReferenceContext.Provider>
  );
}
window.localStorage.removeItem("overlayCalendarSwitchDefault");
function Fixture() {
  const [selected, setSelected] = useState(null);
  const count = innerWidth > 1024 ? 6 : 2;
  const date = scenario === "seam" ? "2030-01-31" : "2030-01-09";
  const days = {};
  for (let offset = -1; offset < 10; offset++) {
    const day = new Date(`${date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const key = day.toISOString().slice(0, 10);
    days[key] =
      scenario === "closure" && offset === 1
        ? []
        : [9, 12, 16].map((hour) => ({
            time: `${key}T${String(hour).padStart(2, "0")}:00:00Z`,
          }));
  }
  return (
    <>
      <main className="bg-default text-default mx-auto flex h-[450px] w-[calc(100%-48px)] flex-col px-5 py-3">
        <Columns
          days={days}
          date={date}
          count={count}
          loading={scenario === "loading"}
          locale="en-US"
          timeZone="UTC"
          timeFormat="h:mma"
          onSelect={setSelected}
        />
      </main>
      <output data-testid="selection">{selected || "none"}</output>
    </>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
