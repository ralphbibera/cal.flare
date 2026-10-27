import { createRoot } from "react-dom/client";
import { Tooltip } from "../../../src/components/Tooltip.tsx";
import { TooltipCases } from "./tooltip-cases.jsx";
import "./candidate.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(<TooltipCases Tooltip={Tooltip} />);
