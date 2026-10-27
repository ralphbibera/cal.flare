import { createRoot } from "react-dom/client";
import { TimeSlots } from "../../../src/components/TimeSlots.tsx";
import "./candidate.css";
import { TimeCases } from "./time-cases.jsx";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(<TimeCases Times={TimeSlots} />);
