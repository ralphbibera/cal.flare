import { createRoot } from "react-dom/client";
import { Input } from "../../../src/components/Input.tsx";
import { InputCases } from "./input-cases.jsx";
import "./candidate.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(<InputCases Input={Input} />);
