import { createRoot } from "react-dom/client";
import { TimeFormatToggle } from "../../../src/components/TimeFormatToggle.tsx";
import { TimeSlots } from "../../../src/components/TimeSlots.tsx";
import { TimeSlotsHeader } from "../../../src/components/TimeSlotsHeader.tsx";
import { TimeSlotsSkeleton } from "../../../src/components/TimeSlotsSkeleton.tsx";
import "./candidate.css";
import { TimeCases } from "./time-cases.jsx";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(
  <TimeCases
    Times={TimeSlots}
    Header={({ showTimeFormatToggle, timeFormat, onFormatChange, controlClassName, ...props }) => (
      <TimeSlotsHeader
        {...props}
        timeFormatToggle={
          showTimeFormatToggle ? (
            <TimeFormatToggle
              value={timeFormat}
              onChange={onFormatChange}
              customClassName={controlClassName}
              labels={{ timeFormat: "Time format", hour12: "12h", hour24: "24h" }}
            />
          ) : undefined
        }
      />
    )}
    Skeleton={TimeSlotsSkeleton}
  />
);
