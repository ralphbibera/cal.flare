import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const zustand = dirname(require.resolve("zustand/package.json"));
const weekReferencePaths = [
  "apps/web/modules/bookings/components/LargeCalendar.tsx",
  "apps/web/modules/calendars/weeklyview/components",
  "packages/features/calendars/weeklyview",
  "packages/lib/timezoneConstants.ts",
  "packages/ui/components/buttonGroup/ButtonGroup.tsx",
  "apps/web/modules/bookings/components/OutOfOfficeInSlots.tsx",
  "packages/lib/components/ServerTrans.tsx",
];
await promisify(execFile)(
  "git",
  ["diff", "--quiet", "0f19cc46ef6b6426ee398c670575b3c96be7af9e", "--", ...weekReferencePaths],
  { cwd: fileURLToPath(new URL("../../../", import.meta.url)) }
);
const weekAliases = {
  "@reference/week": fileURLToPath(
    new URL("../../web/modules/calendars/weeklyview/components/Calendar.tsx", import.meta.url)
  ),
  "@calcom/features/calendars/weeklyview": fileURLToPath(
    new URL("../../../packages/features/calendars/weeklyview", import.meta.url)
  ),
  "@calcom/lib/timezoneConstants": fileURLToPath(
    new URL("../../../packages/lib/timezoneConstants.ts", import.meta.url)
  ),
  "@calcom/ui/components/buttonGroup": fileURLToPath(
    new URL("../../../packages/ui/components/buttonGroup/ButtonGroup.tsx", import.meta.url)
  ),
  "@calcom/web/modules/bookings/components/OutOfOfficeInSlots": fileURLToPath(
    new URL("../../web/modules/bookings/components/OutOfOfficeInSlots.tsx", import.meta.url)
  ),
  "@calcom/lib/components/ServerTrans": fileURLToPath(
    new URL("../../../packages/lib/components/ServerTrans.tsx", import.meta.url)
  ),
  "next/navigation": fileURLToPath(new URL("fixtures/title/week-boundaries.jsx", import.meta.url)),
  "@calcom/lib/hooks/useCompatSearchParams": fileURLToPath(
    new URL("fixtures/title/week-boundaries.jsx", import.meta.url)
  ),
  "zustand/shallow": join(zustand, "esm/shallow.mjs"),
  "zustand/vanilla": join(zustand, "esm/vanilla.mjs"),
  zustand: join(zustand, "esm/index.mjs"),
  "use-sync-external-store/shim/with-selector.js": require.resolve(
    "use-sync-external-store/shim/with-selector"
  ),
};
export const weekPlugin = {
  name: "pinned-week-reference",
  config: () => ({
    resolve: { dedupe: ["react", "react-dom"], alias: weekAliases },
    optimizeDeps: { include: ["use-sync-external-store/shim/with-selector.js"] },
  }),
  resolveId(id, importer) {
    if (id === "@calcom/features/bookings/lib" && importer?.includes("/weeklyview/"))
      return fileURLToPath(new URL("fixtures/title/week-boundaries.jsx", import.meta.url));
  },
};

export async function verifyWeek(browser, origin, artifacts, differentPixels) {
  for (const width of [1280, 900]) {
    for (const scenario of [
      "initial",
      "seam",
      "closure",
      "empty",
      "loading",
      "error",
      "24h",
      "fractional",
      "spring",
      "fall",
      ...(width === 1280 ? ["duration"] : []),
    ]) {
      const captures = { rest: [], hover: [] };
      for (const repeat of [0, 1, "candidate"]) {
        const candidate = repeat === "candidate";
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          locale: "en-US",
          timezoneId: "UTC",
          colorScheme: "light",
        });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          await page.clock.setFixedTime(new Date("2030-01-09T12:00:00Z"));
          await page.goto(`${origin}/week.html?case=${scenario}${candidate ? "&candidate" : ""}`);
          const region = page.locator("main");
          await region.locator(".auto-cols-fr").waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => scrollY > 0);
          await page.evaluate(() => scrollTo(0, 0));
          await page.addStyleTag({
            content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
          });
          const cells = region.getByTestId("calendar-empty-cell");
          const count = width === 1280 ? 7 : 4;
          const unavailable = ["empty", "loading", "error"].includes(scenario);
          assert.equal(
            await cells.count(),
            unavailable
              ? 0
              : ["spring", "fall"].includes(scenario)
                ? 2
                : scenario === "closure"
                  ? (count - 1) * 3
                  : scenario === "initial" || scenario === "24h"
                    ? (count - 1) * 16 + 9
                    : count * 3
          );
          const headers = await region.locator(".auto-cols-fr > div:not(:first-child)").allTextContents();
          const expected =
            scenario === "seam"
              ? ["Mon 31", "Tue 01", "Wed 02", "Thu 03", "Fri 04", "Sat 05", "Sun 06"]
              : scenario === "spring"
                ? ["Sun 10", "Mon 11", "Tue 12", "Wed 13", "Thu 14", "Fri 15", "Sat 16"]
                : scenario === "fall"
                  ? ["Sun 03", "Mon 04", "Tue 05", "Wed 06", "Thu 07", "Fri 08", "Sat 09"]
                  : ["Wed 09", "Thu 10", "Fri 11", "Sat 12", "Sun 13", "Mon 14", "Tue 15"];
          assert.deepEqual(headers, expected.slice(0, count));
          const labels = region.locator(".divide-y > div:not(:first-child) > div");
          assert.equal(await labels.count(), 25);
          assert.equal(await labels.first().textContent(), scenario === "24h" ? "00:00" : "12:00am");
          assert.equal(await labels.last().textContent(), scenario === "24h" ? "00:00" : "12:00am");
          assert.equal((await labels.nth(1).boundingBox()).y - (await labels.first().boundingBox()).y, 58);
          assert.deepEqual(await region.boundingBox(), { x: 24, y: 0, width: width - 48, height: 1471 });
          assert.match(
            await region
              .locator(".grid-rows-1")
              .first()
              .evaluate((node) => getComputedStyle(node).backgroundImage),
            /repeating-linear-gradient\(-45deg/
          );
          assert.equal(await region.locator("svg").count(), scenario === "loading" ? 1 : 0);
          assert.equal(
            await region.locator('[aria-hidden="true"]').textContent(),
            scenario === "fractional"
              ? "5:45pm"
              : ["spring", "fall"].includes(scenario)
                ? "7:00am"
                : scenario === "24h"
                  ? "12:00"
                  : "12:00pm"
          );
          assert.equal(
            await region.evaluate((node) =>
              [...node.querySelectorAll("*")].some(
                (child) =>
                  ["auto", "scroll"].includes(getComputedStyle(child).overflowY) &&
                  child.scrollHeight > child.clientHeight
              )
            ),
            false
          );
          if (!unavailable) {
            const bounds = await cells.first().boundingBox();
            assert.equal(bounds.height, scenario === "duration" ? 58 : 29);
            if (!candidate) {
              assert.equal(await cells.first().getAttribute("tabindex"), null);
              assert.equal(await cells.first().getAttribute("role"), null);
            } else {
              assert.equal(await region.getByRole("button").count(), await cells.count());
            }
            if (["spring", "fall"].includes(scenario)) {
              assert.deepEqual(
                await cells.evaluateAll((nodes) =>
                  nodes.map((node) => [
                    node.dataset.slot,
                    node.textContent,
                    parseFloat(getComputedStyle(node).top),
                  ])
                ),
                scenario === "spring"
                  ? [
                      ["2030-03-10T06:30:00.000Z", "1:30am", 87],
                      ["2030-03-10T07:30:00.000Z", "3:30am", 203],
                    ]
                  : [
                      ["2030-11-03T05:30:00.000Z", "1:30am", 87],
                      ["2030-11-03T06:30:00.000Z", "1:30am", 87],
                    ]
              );
            }
            if (["initial", "24h", "fractional"].includes(scenario)) {
              assert.equal(
                await cells.first().getAttribute("data-slot"),
                scenario === "fractional" ? "2030-01-09T09:00:00.000Z" : "2030-01-09T12:30:00.000Z"
              );
              assert.equal(
                await cells.first().evaluate((node) => parseFloat(getComputedStyle(node).top)),
                scenario === "fractional" ? 855.5 : 725
              );
            }
          }
          for (const state of unavailable ? ["rest"] : ["rest", "hover"]) {
            if (state === "hover") await (scenario === "fall" ? cells.last() : cells.first()).hover();
            if (state === "hover") {
              assert.deepEqual(
                await (scenario === "fall" ? cells.last() : cells.first())
                  .locator(":scope > div")
                  .evaluate((node) => {
                    const style = getComputedStyle(node);
                    return [
                      style.backgroundColor,
                      style.color,
                      style.borderRadius,
                      node.getBoundingClientRect().height,
                    ];
                  }),
                ["rgb(41, 41, 41)", "rgb(255, 255, 255)", "4px", scenario === "duration" ? 56 : 27]
              );
            }
            captures[state].push([
              ...(await region.screenshot({
                path: fileURLToPath(
                  new URL(
                    `week-grid-${candidate ? "candidate" : "reference"}-${width}-${scenario}-${state}-${repeat}.png`,
                    artifacts
                  )
                ),
                animations: "disabled",
              })),
            ]);
            if (repeat)
              assert.equal(
                await page.evaluate(differentPixels, [captures[state][0], captures[state].at(-1)]),
                0,
                `${candidate ? "candidate" : "reference repeat"} ${width}/${scenario}/${state} every RGBA channel`
              );
          }
          if (candidate && !unavailable) {
            for (let index = 0; index < (await cells.count()); index++) {
              await page.keyboard.press("Tab");
              const slot = cells.nth(index);
              assert.ok(await slot.evaluate((node) => document.activeElement === node));
              assert.ok(await slot.evaluate((node) => node.matches(":focus-visible")));
              assert.ok(
                await slot.evaluate((node) => {
                  const style = getComputedStyle(node);
                  return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
                })
              );
              assert.ok(await slot.locator(":scope > div").isVisible());
              assert.match(await slot.getAttribute("aria-label"), /2030|2029/);
              await page.keyboard.press(index % 2 ? "Space" : "Enter");
              assert.equal(
                await page.getByTestId("selection").textContent(),
                await slot.getAttribute("data-slot")
              );
              if (scenario === "fall") {
                assert.equal(
                  await page.getByTestId("selection").textContent(),
                  ["2030-11-03T05:30:00.000Z", "2030-11-03T06:30:00.000Z"][index]
                );
                await region.screenshot({
                  path: fileURLToPath(
                    new URL(`week-grid-candidate-${width}-fall-keyboard-${index}.png`, artifacts)
                  ),
                  animations: "disabled",
                });
              }
            }
            if (scenario === "fall") {
              assert.deepEqual(
                await cells.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
                [
                  "Sunday, November 3, 2030, 1:30am, America/New_York UTC-04:00",
                  "Sunday, November 3, 2030, 1:30am, America/New_York UTC-05:00",
                ]
              );
            }
          }
          if (!unavailable) {
            const slot = scenario === "fall" ? cells.last() : cells.first();
            const identity = await slot.getAttribute("data-slot");
            await slot.click();
            assert.equal(await page.getByTestId("selection").textContent(), identity);
            assert.equal(
              identity,
              scenario === "fall"
                ? "2030-11-03T06:30:00.000Z"
                : scenario === "spring"
                  ? "2030-03-10T06:30:00.000Z"
                  : scenario === "initial" || scenario === "24h"
                    ? "2030-01-09T12:30:00.000Z"
                    : scenario === "seam"
                      ? "2029-12-31T09:00:00.000Z"
                      : "2030-01-09T09:00:00.000Z"
            );
          } else {
            assert.equal(await page.getByTestId("selection").textContent(), "none");
            if (candidate) assert.equal(await region.getByRole("button").count(), 0);
          }
          if (scenario === "initial") {
            const currentTime = region.locator('[aria-hidden="true"]');
            assert.equal(await currentTime.textContent(), "12:00pm");
            assert.equal(await currentTime.evaluate((node) => parseFloat(getComputedStyle(node).top)), 724);
            await page.clock.setFixedTime(new Date("2030-01-09T13:00:00Z"));
            await cells.nth(1).click();
            assert.equal(await page.getByTestId("selection").textContent(), "2030-01-09T13:00:00.000Z");
            assert.equal(await currentTime.textContent(), "1:00pm", "current-time label after rerender");
            assert.equal(
              await currentTime.evaluate((node) => parseFloat(getComputedStyle(node).top)),
              724,
              "stored current-time position after rerender"
            );
            console.log(
              `PASS week ${width}/initial/${repeat} clock advance/rerender 12:00pm -> 1:00pm, position 724px, UTC selection 13:00Z`
            );
          }
          assert.deepEqual(errors, []);
          console.log(
            `PASS week ${candidate ? "candidate pixels/keyboard" : "reference"} ${width}/${scenario}/${repeat}`
          );
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log(
    "PASS unchanged pinned Calendar baseline with 34 original reference-repeat pairs and 34 independent candidate pairs at 1280/900, plus two duration pairs for each. Every RGBA channel matches. Anchored dates, 58px hours, 30/60-minute cells, UTC pointer selection, every candidate slot by Tab/Enter/Space, unavailable states and literal DST placement pass. Native keyboard parity is not claimed."
  );
}
