import { Provider } from "@radix-ui/react-tooltip";
import { useState } from "react";

export function MonthCases({ Picker }) {
  const scenario = new URLSearchParams(location.search).get("case") || "early";
  const late = scenario === "late" || scenario === "compact";
  const leap = scenario === "leap";
  const [month, setMonth] = useState(leap ? "2032-02-01" : "2030-01-01");
  const [selected, setSelected] = useState(scenario === "selected" ? "2030-01-12" : null);
  let includedDates = ["2030-01-10", "2030-01-12", "2030-01-13", "2030-02-01"];
  if (late) includedDates = ["2030-01-21", "2030-01-22", "2030-02-01"];
  if (leap) includedDates = ["2032-02-29"];
  if (["loading", "empty"].includes(scenario)) includedDates = [];
  if (scenario === "ooo") includedDates = ["2030-01-13"];
  const slots = Object.fromEntries(includedDates.map((date) => [date, [{ time: `${date}T10:00:00Z` }]]));
  if (scenario === "ooo") {
    slots["2030-01-11"] = [{ away: true, emoji: "🌴", toUser: { username: "bob" } }];
    slots["2030-01-12"] = [{ away: true, emoji: "🌴" }];
    slots["2030-01-13"].push({ away: true, emoji: "🌴" });
  }
  return (
    <Provider>
      <main className="mx-auto w-full max-w-sm rounded-xl border border-default bg-default p-6 text-default">
        <Picker
          month={month}
          selected={selected}
          onDate={setSelected}
          onMonth={setMonth}
          includedDates={includedDates}
          slots={slots}
          isLoading={scenario === "loading"}
          isCompact={scenario === "compact"}
          weekStart={scenario === "monday" ? 1 : 0}
          minDate={scenario === "minimum" ? "2030-01-12T12:00:00Z" : undefined}
        />
        <output data-testid="selection">{selected || "none"}</output>
      </main>
    </Provider>
  );
}
