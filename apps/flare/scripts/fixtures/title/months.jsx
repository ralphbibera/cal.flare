import dayjs from "@calcom/dayjs";
import { DatePicker } from "@reference/calendar-day";
import { createRoot } from "react-dom/client";
import inter from "../../../../web/public/fonts/Inter-roman.var.woff2?url";
import sprite from "../../../../web/public/icons/sprite.svg?raw";
import "../../../../web/styles/globals.css";
import { CalendarReferenceContext } from "@calcom/features/bookings/Booker/BookerStoreProvider";
import { MonthCases } from "./month-cases.jsx";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
document.body.prepend(new DOMParser().parseFromString(sprite, "image/svg+xml").documentElement);
const fonts = document.createElement("style");
fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
document.head.append(fonts);
createRoot(document.getElementById("root")).render(
  <CalendarReferenceContext.Provider
    value={{
      layout: "month_view",
      bookingData: null,
      selectedDatesAndTimes: {},
      slotsViewOnSmallScreen: false,
    }}>
    <MonthCases
      Picker={({ month, selected, onDate, onMonth, minDate, offsetMinutes, ...props }) => (
        <DatePicker
          {...props}
          locale="en-US"
          browsingDate={offsetMinutes === undefined ? dayjs(month) : dayjs(month).utcOffset(offsetMinutes)}
          selected={selected ? dayjs(selected) : null}
          minDate={minDate ? new Date(minDate) : undefined}
          onChange={(date) => onDate(date?.format("YYYY-MM-DD") || null)}
          onMonthChange={(date) => onMonth(date.format("YYYY-MM-DD"))}
          showNoAvailabilityDialog={false}
        />
      )}
    />
  </CalendarReferenceContext.Provider>
);
