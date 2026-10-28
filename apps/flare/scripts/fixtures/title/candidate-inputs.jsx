import { createRoot } from "react-dom/client";
import { Input } from "../../../src/components/Input.tsx";
import { Label } from "../../../src/components/Label.tsx";
import { TextArea } from "../../../src/components/TextArea.tsx";
import { InputCases } from "./input-cases.jsx";
import "./candidate.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
createRoot(document.getElementById("root")).render(
  <InputCases Input={Input} Label={Label} TextArea={TextArea} />
);
