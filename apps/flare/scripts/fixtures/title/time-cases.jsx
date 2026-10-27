import { useState } from "react";

export function TimeCases({ Times }) {
  const scenario = new URLSearchParams(location.search).get("case") || "twelve";
  const [selected, setSelected] = useState(null);
  const times = ["2030-01-10T09:00:00Z", "2030-01-10T12:30:00Z", "2030-01-10T23:00:00Z"];
  const selectedSlots = scenario === "selected" ? [times[1]] : [];
  return (
    <main className="mx-auto w-full max-w-sm rounded-xl border border-default bg-default p-6 text-default">
      <Times
        slots={times.map((time) => ({ time }))}
        timeZone={scenario === "zone" ? "Asia/Kolkata" : "UTC"}
        timeFormat={scenario === "twentyfour" ? "HH:mm" : "h:mma"}
        selectedSlots={selectedSlots}
        unavailableSlots={scenario === "unavailable" ? [times[1]] : []}
        disabled={scenario === "loading"}
        onSelect={setSelected}
      />
      <output data-testid="selection">{selected || "none"}</output>
    </main>
  );
}
