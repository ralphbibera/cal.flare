import { useState } from "react";

export function TimeCases({ Times, Header, Skeleton }) {
  const scenario = new URLSearchParams(location.search).get("case") || "twelve";
  const [selected, setSelected] = useState(null);
  const [timeFormat, setTimeFormat] = useState(scenario.endsWith("twentyfour") ? "HH:mm" : "h:mma");
  const times = ["2030-01-10T09:00:00Z", "2030-01-10T12:30:00Z", "2030-01-10T23:00:00Z"];
  const selectedSlots = scenario === "selected" ? [times[1]] : [];
  if (scenario.startsWith("skeleton-")) {
    return (
      <main className="mx-auto w-full max-w-sm rounded-xl border border-default bg-default p-6 text-default">
        <Skeleton />
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-sm rounded-xl border border-default bg-default p-6 text-default">
      <Header
        date="2030-01-09"
        weekday="Wed"
        day="09"
        isToday
        showTimeFormatToggle={scenario.startsWith("format-")}
        timeFormat={timeFormat}
        onFormatChange={setTimeFormat}
        controlClassName={scenario === "format-custom" ? "rounded-none p-2" : undefined}
      />
      <Header date="2030-01-10" weekday="Thu" day="10" />
      <Header date="2030-01-11" weekday="Fri" day="11" availableMonth="January" />
      <Header
        date="2030-01-12"
        weekday="Sat"
        day="12"
        customClassNames={{
          availableTimeSlotsHeaderContainer: "border border-default rounded-md p-2",
          availableTimeSlotsTitle: "text-xs uppercase",
        }}
      />
      <Times
        slots={times.map((time) => ({ time }))}
        timeZone={scenario === "zone" ? "Asia/Kolkata" : "UTC"}
        timeFormat={timeFormat}
        selectedSlots={selectedSlots}
        unavailableSlots={scenario === "unavailable" ? [times[1]] : []}
        disabled={scenario === "loading"}
        onSelect={setSelected}
      />
      <output data-testid="selection">{selected || "none"}</output>
    </main>
  );
}
