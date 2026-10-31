import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const sources = [
  "apps/web/modules/schedules/hooks/useNonEmptyScheduleDays.ts",
  "apps/web/modules/schedules/hooks/useSlotsForDate.ts",
];
async function verifyColumnScenario(browser, origin, artifacts, differentPixels, width, scenario) {
  const captures = [];
  let reference;
  for (const candidate of [false, true]) {
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
      await page.addInitScript(() => {
        Math.random = () => 0.5;
      });
      await page.goto(`${origin}/columns.html?case=${scenario}${candidate ? "&candidate" : ""}`);
      const region = page.locator("main");
      const count = width === 1280 ? 6 : 2;
      await assertColumnContent(region, count, scenario);
      await page.evaluate(() => document.fonts.ready);
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });
      const measured = {
        bounds: await region.boundingBox(),
        headers: await region.locator("header").allTextContents(),
        slots: await region.getByTestId("time").allTextContents(),
      };
      if (!candidate) reference = measured;
      else assert.deepEqual(measured, reference);
      const expected = expectedColumnHeaders(scenario);
      assert.deepEqual(measured.headers, scenario === "loading" ? [] : expected.slice(0, count));
      captures.push([
        ...(await region.screenshot({
          path: fileURLToPath(
            new URL(`${candidate ? "candidate" : "reference"}-columns-${width}-${scenario}.png`, artifacts)
          ),
          animations: "disabled",
        })),
      ]);
      if (candidate)
        assert.equal(
          await page.evaluate(differentPixels, captures),
          0,
          `${width}/${scenario} every RGBA channel`
        );
      if (scenario !== "loading") {
        const slot = region.getByTestId("time").first();
        const identity = await slot.getAttribute("data-time");
        await slot.focus();
        await slot.press("Enter");
        assert.equal(await page.getByTestId("selection").textContent(), identity);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

async function assertColumnContent(region, count, scenario) {
  if (scenario === "loading") {
    await region.locator("span.animate-pulse").first().waitFor();
    assert.equal(await region.locator("span.animate-pulse").count(), (count + 1) * 4);
  } else {
    await region.getByTestId("time").first().waitFor();
    assert.equal(await region.locator("header").count(), count);
    assert.equal(await region.getByTestId("time").count(), count * 3);
  }
}

function expectedColumnHeaders(scenario) {
  if (scenario === "seam")
    return ["Thu31", "Fri01, Feb", "Sat02, Feb", "Sun03, Feb", "Mon04, Feb", "Tue05, Feb"];
  if (scenario === "closure") return ["Wed09", "Fri11", "Sat12", "Sun13", "Mon14", "Tue15"];
  return ["Wed09", "Thu10", "Fri11", "Sat12", "Sun13", "Mon14"];
}

export const columnReferencePaths = sources;
export const columnAliases = Object.fromEntries([
  ...sources.map((path) => [
    `@calcom/web/${path.slice("apps/web/".length, -3)}`,
    fileURLToPath(new URL(`../../../${path}`, import.meta.url)),
  ]),
  ...["AvailableTimes", "AvailableTimesHeader"].map((name) => [
    `@calcom/web/modules/bookings/components/${name}`,
    fileURLToPath(new URL(`../../web/modules/bookings/components/${name}.tsx`, import.meta.url)),
  ]),
  [
    "@reference/times",
    fileURLToPath(new URL("../../web/modules/bookings/components/AvailableTimes.tsx", import.meta.url)),
  ],
  ["@calcom/lib/constants", fileURLToPath(new URL("fixtures/title/column-boundaries.jsx", import.meta.url))],
]);

export async function verifyColumns(browser, origin, artifacts, differentPixels) {
  assert.match(browser.version(), /^143\./);
  for (const width of [1280, 900]) {
    for (const scenario of ["initial", "seam", "closure", "loading"]) {
      await verifyColumnScenario(browser, origin, artifacts, differentPixels, width, scenario);
    }
  }
  console.log(
    "PASS column presentation executes pinned AvailableTimeSlots and real schedule hooks with exact geometry/RGBA at 1280/900, six/two dates, closures, month seams, loading and keyboard UTC selection."
  );
}
