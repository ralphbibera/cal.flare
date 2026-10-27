import { EventTitle } from "@reference/title";
import { createRoot } from "react-dom/client";
import inter from "../../../../web/public/fonts/Inter-roman.var.woff2?url";
import "../../../../web/styles/globals.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
const fonts = document.createElement("style");
fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
document.head.append(fonts);

createRoot(document.getElementById("root")).render(
  <main className="mx-auto w-full max-w-sm space-y-6 rounded-xl border border-default bg-default p-6 text-default">
    <EventTitle>Quick chat</EventTitle>
    <EventTitle>A longer conversation about building thoughtful open-source software together</EventTitle>
    <EventTitle as="h2" className="text-2xl">
      A different heading level
    </EventTitle>
  </main>
);
