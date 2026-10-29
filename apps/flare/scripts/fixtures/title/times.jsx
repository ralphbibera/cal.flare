import dayjs from "@calcom/dayjs";
import { AvailableTimes, AvailableTimesSkeleton } from "@reference/times";
import { AvailableTimesHeader } from "@reference/times-header";
import { createRoot } from "react-dom/client";
import inter from "../../../../web/public/fonts/Inter-roman.var.woff2?url";
import "../../../../web/styles/globals.css";
import { CalendarReferenceContext } from "./calendar-boundaries.jsx";
import { TimeCases } from "./time-cases.jsx";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
const fonts = document.createElement("style");
fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
document.head.append(fonts);
window.localStorage.removeItem("overlayCalendarSwitchDefault");
const layout = matchMedia("(max-width: 768px)").matches ? "mobile" : "month_view";
createRoot(document.getElementById("root")).render(
  <TimeCases
    Skeleton={AvailableTimesSkeleton}
    Header={({
      date,
      customClassNames,
      availableMonth,
      showTimeFormatToggle = false,
      timeFormat,
      onFormatChange,
      controlClassName,
    }) => (
      <CalendarReferenceContext.Provider value={{ layout, timeFormat, setTimeFormat: onFormatChange }}>
        <AvailableTimesHeader
          date={dayjs(date)}
          showTimeFormatToggle={showTimeFormatToggle}
          customClassNames={{ ...customClassNames, availableTimeSlotsTimeFormatToggle: controlClassName }}
          availableMonth={availableMonth}
        />
      </CalendarReferenceContext.Provider>
    )}
    Times={({ timeZone, timeFormat, unavailableSlots, disabled, onSelect, ...props }) => (
      <CalendarReferenceContext.Provider
        value={{ timeZone, timeFormat, layout, bookingData: null, selectedTimeslot: null }}>
        <AvailableTimes
          {...props}
          unavailableTimeSlots={unavailableSlots}
          loadingStates={{ creatingBooking: disabled }}
          event={{ data: { price: 0, length: 30 } }}
          handleSlotClick={(slot) => onSelect(slot.time)}
        />
      </CalendarReferenceContext.Provider>
    )}
  />
);
