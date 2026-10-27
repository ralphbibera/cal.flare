import { useState } from "react";

export function CalendarCases({ Cell }) {
  const [count, setCount] = useState(0);
  const cases = [
    { date: "2030-01-03" },
    { date: "2030-01-04", active: true },
    { date: "2030-01-05", disabled: true },
    { date: "2030-01-09" },
    { date: "2030-01-09", active: true },
    { date: "2030-01-09", disabled: true },
    { date: "2030-01-10", away: true, emoji: "🌴" },
    { date: "2030-01-11", away: true, disabled: true, emoji: "🌴" },
    { date: "2030-02-01", isFirstDayOfNextMonth: true },
    { date: "2030-02-01", isFirstDayOfNextMonth: true, active: true },
    { date: "2030-02-01", isFirstDayOfNextMonth: true, disabled: true },
    { date: "2030-01-12", customClassName: { dayActive: "bg-red-100 text-red-800" } },
  ];
  return (
    <main className="mx-auto w-full max-w-sm rounded-xl border border-default bg-default p-6 text-default">
      <div className="relative grid grid-cols-7 grid-rows-6 gap-1 text-center">
        {cases.map((props, index) => (
          <div key={index} className="relative w-full pt-[100%]">
            <Cell
              active={false}
              disabled={false}
              {...props}
              aria-label={`Date ${index}`}
              onClick={() => setCount((value) => value + 1)}
            />
          </div>
        ))}
      </div>
      <output aria-label="Selections">{count}</output>
    </main>
  );
}
