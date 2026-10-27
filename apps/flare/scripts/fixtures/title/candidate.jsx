import { createRoot } from "react-dom/client";
import { EventTitle } from "../../../src/components/EventTitle.tsx";
import "./candidate.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);

createRoot(document.getElementById("root")).render(
  <main className="mx-auto w-full max-w-sm space-y-6 rounded-xl border border-default bg-default p-6 text-default">
    <EventTitle>Quick chat</EventTitle>
    <EventTitle>A longer conversation about building thoughtful open-source software together</EventTitle>
    <EventTitle as="h2" className="text-2xl">
      A different heading level
    </EventTitle>
  </main>
);
