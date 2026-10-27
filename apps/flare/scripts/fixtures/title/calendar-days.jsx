import dayjs from "@calcom/dayjs";
import { Day } from "@reference/calendar-day";
import { createRoot } from "react-dom/client";
import inter from "../../../../web/public/fonts/Inter-roman.var.woff2?url";
import "../../../../web/styles/globals.css";
import { CalendarCases } from "./calendar-cases.jsx";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
const fonts = document.createElement("style");
fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
document.head.append(fonts);
createRoot(document.getElementById("root")).render(
  <CalendarCases Cell={({ date, ...props }) => <Day date={dayjs(date)} {...props} />} />
);
