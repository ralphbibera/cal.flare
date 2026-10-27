import { createRoot } from "react-dom/client";
import { Button } from "../../../src/components/Button.tsx";
import { ButtonCases } from "./button-cases.jsx";
import "./candidate.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(<ButtonCases Button={Button} />);
