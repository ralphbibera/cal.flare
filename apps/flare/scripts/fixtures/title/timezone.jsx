import { useState } from "react";
import { createRoot } from "react-dom/client";
import inter from "../../../../web/public/fonts/Inter-roman.var.woff2?url";

const query = new URLSearchParams(location.search);
const candidate = query.has("candidate");
const { TimezoneSelect } = candidate
  ? await import("../../../src/components/TimezoneSelect.tsx")
  : await import("@reference/timezone").then(({ TimezoneSelectComponent }) => ({
      TimezoneSelect: TimezoneSelectComponent,
    }));
await (candidate ? import("./candidate.css") : import("../../../../web/styles/globals.css"));
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
const fonts = document.createElement("style");
fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
document.head.append(fonts);

const data = [
  { label: "Kolkata", timezone: "Asia/Kolkata" },
  { label: "London", timezone: "Europe/London" },
  { label: "New York", timezone: "America/New_York" },
  { label: "India Standard Time", timezone: "Asia/Kolkata" },
];
function Example() {
  const [value, setValue] = useState(query.has("selected") ? "Asia/Kolkata" : "UTC");
  return (
    <main className="mx-auto w-64 max-w-full rounded-md bg-default p-6 text-default text-sm font-medium">
      <button type="button">Before</button>
      <div className="relative my-6 h-6 max-w-full">
        <TimezoneSelect
          data={data}
          value={value}
          isPending={false}
          isDisabled={query.has("disabled")}
          disabled={query.has("disabled")}
          label="Timezone Select"
          onChange={candidate ? setValue : (option) => setValue(option.value)}
          classNames={{
            control: () => "min-h-0! p-0 w-full border-0 bg-transparent focus-within:ring-0 shadow-none!",
            menu: () => "w-64! max-w-[90vw] mb-1 ",
            singleValue: () => "text-text py-1",
            indicatorsContainer: () => "ml-auto",
            container: () => "max-w-full",
          }}
        />
      </div>
      <output aria-label="Selected timezone">{value}</output>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<Example />);
