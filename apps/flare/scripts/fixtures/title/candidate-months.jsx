import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { createRoot } from "react-dom/client";
import strings from "../../../../../packages/i18n/locales/en/common.json";
import { MonthPicker } from "../../../src/components/MonthPicker.tsx";
import "./candidate.css";
import { MonthCases } from "./month-cases.jsx";

dayjs.extend(utc);
document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(
  <MonthCases
    Picker={({ month, selected, onDate, onMonth, minDate, offsetMinutes, ...props }) => (
      <MonthPicker
        {...props}
        locale="en-US"
        labels={{
          today: strings.today,
          previousMonth: strings.view_previous_month,
          nextMonth: strings.view_next_month,
        }}
        browsingDate={offsetMinutes === undefined ? dayjs(month) : dayjs(month).utcOffset(offsetMinutes)}
        selected={selected ? dayjs(selected) : null}
        minDate={minDate ? new Date(minDate) : undefined}
        onChange={(date) => onDate(date?.format("YYYY-MM-DD") || null)}
        onMonthChange={(date) => onMonth(date.format("YYYY-MM-DD"))}
      />
    )}
  />
);
