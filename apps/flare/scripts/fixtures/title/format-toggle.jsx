import { useState } from "react";
import { createRoot } from "react-dom/client";
import inter from "../../../../web/public/fonts/Inter-roman.var.woff2?url";
import { CalendarReferenceContext } from "./calendar-boundaries.jsx";

const query = new URLSearchParams(location.search);
const candidate = query.has("candidate");
const { TimeFormatToggle } = candidate
  ? await import("../../../src/components/TimeFormatToggle.tsx")
  : await import("@reference/time-format-toggle");
await (candidate ? import("./candidate.css") : import("../../../../web/styles/globals.css"));
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
const fonts = document.createElement("style");
fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
document.head.append(fonts);

function Example() {
  const [timeFormat, setTimeFormat] = useState(query.has("twentyfour") ? "HH:mm" : "h:mma");
  const props = candidate
    ? {
        value: timeFormat,
        onChange: setTimeFormat,
        labels: { timeFormat: "Time format", hour12: "12h", hour24: "24h" },
      }
    : {};
  return (
    <CalendarReferenceContext.Provider value={{ timeFormat, setTimeFormat }}>
      <main className="mx-auto w-full max-w-sm space-y-6 rounded-xl border border-default bg-default p-6 text-default">
        <button type="button">Before</button>
        <div>
          <TimeFormatToggle {...props} />
        </div>
        <div>
          <TimeFormatToggle {...props} customClassName="rounded-none p-2" />
        </div>
        <button type="button">After</button>
        <output aria-label="Selected format">{timeFormat}</output>
      </main>
    </CalendarReferenceContext.Provider>
  );
}
createRoot(document.getElementById("root")).render(<Example />);
