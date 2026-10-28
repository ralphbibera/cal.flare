import { EventMetaBlock } from "@reference/meta";
import { createRoot } from "react-dom/client";
import inter from "../../../../web/public/fonts/Inter-roman.var.woff2?url";
import sprite from "../../../../web/public/icons/sprite.svg?raw";
import "../../../../web/styles/globals.css";
import { MetaCases } from "./meta-cases.jsx";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
document.body.prepend(new DOMParser().parseFromString(sprite, "image/svg+xml").documentElement);
const fonts = document.createElement("style");
fonts.textContent = `@font-face { font-family: Inter; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; } :root { --font-sans: Inter, system-ui, sans-serif; }`;
document.head.append(fonts);
createRoot(document.getElementById("root")).render(<MetaCases Block={EventMetaBlock} />);
