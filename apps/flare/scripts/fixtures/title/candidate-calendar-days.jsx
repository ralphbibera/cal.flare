import { createRoot } from "react-dom/client";
import strings from "../../../../../packages/i18n/locales/en/common.json";
import { CalendarDay } from "../../../src/components/CalendarDay.tsx";
import { CalendarCases } from "./calendar-cases.jsx";
import "./candidate.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(
  <CalendarCases
    Cell={({ date, isFirstDayOfNextMonth, ...props }) => (
      <CalendarDay
        {...props}
        day={new Date(date).getUTCDate()}
        isToday={date === new Date().toISOString().slice(0, 10)}
        todayLabel={strings.today}
        monthLabel={
          isFirstDayOfNextMonth
            ? new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(date))
            : undefined
        }
      />
    )}
  />
);
