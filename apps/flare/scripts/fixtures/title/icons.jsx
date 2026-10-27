import { Icon } from "@reference/icon";
import { createRoot } from "react-dom/client";
import sprite from "../../../../web/public/icons/sprite.svg?raw";
import "../../../../web/styles/globals.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark"
);
const symbols = new DOMParser().parseFromString(sprite, "image/svg+xml").documentElement;
const names = [...symbols.querySelectorAll("symbol")].map((symbol) => symbol.id);
document.body.prepend(symbols);

createRoot(document.getElementById("root")).render(
  <main className="grid grid-cols-6 gap-4 rounded-xl border border-default bg-default p-6 text-default">
    {names.map((name) => (
      <Icon key={name} name={name} data-testid="sprite-icon" />
    ))}
    <Icon name="clock" size={24} data-testid="number-size" />
    <Icon name="globe" size="2rem" data-testid="string-size" />
    <Icon name="calendar" className="h-8 w-8 fill-red-500" data-testid="class-override" />
    <Icon
      name="arrow-right"
      width={40}
      height={20}
      style={{ color: "rebeccapurple" }}
      data-testid="svg-props"
    />
  </main>
);
