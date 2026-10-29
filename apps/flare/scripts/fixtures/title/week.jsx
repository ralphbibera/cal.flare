import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useCalcomTheme } from "../../../../../packages/ui/styles/useCalcomTheme.tsx";
import { WeekPreferences } from "./week-boundaries.jsx";

const params = new URLSearchParams(location.search);
const scenario = params.get("case") || "initial";
let Week;
{
  await import("../../../../web/styles/globals.css");
  const { default: inter } = await import("../../../../web/public/fonts/Inter-roman.var.woff2?url");
  const fonts = document.createElement("style");
  fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
  document.head.append(fonts);
  const { Calendar } = await import("@reference/week");
  Week = ({ date, count, days, timeZone, duration, status, onSelect }) => (
    <Calendar
      startDate={new Date(`${date}T00:00:00Z`)}
      endDate={new Date(Date.parse(`${date}T00:00:00Z`) + (count - 1) * 86400000)}
      startHour={0}
      endHour={23}
      events={[]}
      availableTimeslots={Object.fromEntries(
        Object.entries(status === "ready" ? days : {}).map(([date, slots]) => [
          date,
          slots.map(({ time }) => ({
            start: time,
            end: new Date(Date.parse(time) + duration * 60000).toISOString(),
          })),
        ])
      )}
      isPending={status === "loading"}
      gridCellsPerHour={60 / duration}
      hoverEventDuration={duration}
      hideHeader
      timezone={timeZone}
      onEmptyCellClick={(date) => onSelect(date.toISOString())}
    />
  );
}
function Fixture() {
  useCalcomTheme({ root: { "cal-brand": "#292929", "cal-brand-text": "#ffffff" } });
  const [selected, setSelected] = useState(null);
  const count = innerWidth > 1024 ? 7 : 4;
  const date =
    scenario === "seam"
      ? "2029-12-31"
      : scenario === "spring"
        ? "2030-03-10"
        : scenario === "fall"
          ? "2030-11-03"
          : "2030-01-09";
  const timeZone =
    scenario === "fractional"
      ? "Asia/Kathmandu"
      : ["spring", "fall"].includes(scenario)
        ? "America/New_York"
        : "UTC";
  const timeFormat = scenario === "24h" ? "HH:mm" : "h:mma";
  const days = {};
  for (let offset = 0; offset < count; offset++) {
    const key = new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    const minutes =
      scenario === "initial" || scenario === "24h"
        ? Array.from({ length: offset === 0 ? 9 : 16 }, (_, index) => (offset === 0 ? 750 : 540) + index * 30)
        : [540, 720, 960];
    days[key] =
      scenario === "closure" && offset === 1
        ? []
        : minutes.map((minute) => ({
            time: new Date(Date.parse(`${key}T00:00:00Z`) + minute * 60000).toISOString(),
          }));
  }
  if (scenario === "spring" || scenario === "fall") {
    for (const key of Object.keys(days)) days[key] = [];
    days[date] = (
      scenario === "spring"
        ? ["2030-03-10T06:30:00.000Z", "2030-03-10T07:30:00.000Z"]
        : ["2030-11-03T05:30:00.000Z", "2030-11-03T06:30:00.000Z"]
    ).map((time) => ({ time }));
  }
  const status = ["loading", "error"].includes(scenario) ? scenario : "ready";
  return (
    <WeekPreferences.Provider value={{ timeFormat }}>
      <main className="bg-default text-default mx-auto w-[calc(100%-48px)]" data-week-ready>
        <Week
          date={date}
          count={count}
          days={scenario === "empty" ? {} : days}
          duration={30}
          status={status}
          timeZone={timeZone}
          timeFormat={timeFormat}
          onSelect={setSelected}
        />
      </main>
      <output data-testid="selection">{selected || "none"}</output>
    </WeekPreferences.Provider>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
