import { createRoot } from "react-dom/client";
import { EventMetaBlock } from "../../../src/components/EventMetaBlock.tsx";
import { MetaCases } from "./meta-cases.jsx";
import "./candidate.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(<MetaCases Block={EventMetaBlock} />);
