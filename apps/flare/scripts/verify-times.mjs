import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const timeScenarios = [
  {
    name: "twelve",
    kind: "rows",
    labels: ["9:00am", "12:30pm", "11:00pm"],
    firstHeader: "Wed09",
    disabledFirst: false,
    disabledSecond: false,
    selectedCount: 0,
    format: null,
  },
  {
    name: "twentyfour",
    kind: "rows",
    labels: ["09:00", "12:30", "23:00"],
    firstHeader: "Wed09",
    disabledFirst: false,
    disabledSecond: false,
    selectedCount: 0,
    format: null,
  },
  {
    name: "zone",
    kind: "rows",
    labels: ["2:30pm", "6:00pm", "4:30am"],
    firstHeader: "Wed09",
    disabledFirst: false,
    disabledSecond: false,
    selectedCount: 0,
    format: null,
  },
  {
    name: "selected",
    kind: "rows",
    labels: ["9:00am", "12:30pm", "11:00pm"],
    firstHeader: "Wed09",
    disabledFirst: false,
    disabledSecond: false,
    selectedCount: 1,
    format: null,
  },
  {
    name: "unavailable",
    kind: "rows",
    labels: ["9:00am", "12:30pm", "11:00pm"],
    firstHeader: "Wed09",
    disabledFirst: false,
    disabledSecond: true,
    selectedCount: 0,
    format: null,
  },
  {
    name: "loading",
    kind: "rows",
    labels: ["9:00am", "12:30pm", "11:00pm"],
    firstHeader: "Wed09",
    disabledFirst: true,
    disabledSecond: true,
    selectedCount: 0,
    format: null,
  },
  {
    name: "format-twelve",
    kind: "rows",
    labels: ["9:00am", "12:30pm", "11:00pm"],
    firstHeader: "Wed0912h24h",
    disabledFirst: false,
    disabledSecond: false,
    selectedCount: 0,
    format: { checked: "12h", square: false },
  },
  {
    name: "format-twentyfour",
    kind: "rows",
    labels: ["09:00", "12:30", "23:00"],
    firstHeader: "Wed0912h24h",
    disabledFirst: false,
    disabledSecond: false,
    selectedCount: 0,
    format: { checked: "24h", square: false },
  },
  {
    name: "format-custom",
    kind: "rows",
    labels: ["9:00am", "12:30pm", "11:00pm"],
    firstHeader: "Wed0912h24h",
    disabledFirst: false,
    disabledSecond: false,
    selectedCount: 0,
    format: { checked: "12h", square: true },
  },
  { name: "skeleton-1", kind: "skeleton", count: 1, random: 0 },
  { name: "skeleton-4", kind: "skeleton", count: 4, random: 0.5 },
  { name: "skeleton-6", kind: "skeleton", count: 6, random: 0.999999 },
];

async function checkTimeSkeletons(page, expected) {
  const placeholders = page.locator("main span.animate-pulse");
  await placeholders.first().waitFor();
  assert.equal(await placeholders.count(), expected.count);
  assert.equal(await page.locator("main button").count(), 0);
  assert.ok(
    await placeholders.evaluateAll((nodes) =>
      nodes.every(
        (node) =>
          node.getBoundingClientRect().width > 0 &&
          node.getBoundingClientRect().height === 24 &&
          getComputedStyle(node).marginBottom === "16px" &&
          getComputedStyle(node).animationName === "pulse"
      )
    )
  );
}

async function checkTimeHeadings(page, viewport, firstHeader) {
  assert.deepEqual(await page.locator("main header").allTextContents(), [
    firstHeader,
    "Thu10",
    "Fri11, January",
    "Sat12",
    "Sun13",
  ]);
  const headingStyles = await page.locator("main header").evaluateAll((headers) =>
    headers.map((header) =>
      [...header.querySelector("span").children].map((span) => {
        const style = getComputedStyle(span);
        return {
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          color: style.color,
        };
      })
    )
  );
  const mobile = viewport.width <= 768;
  assert.equal(headingStyles[0][0].fontSize, "16px");
  assert.equal(headingStyles[0][0].lineHeight, "24px");
  assert.equal(headingStyles[0][1].fontSize, mobile ? "12px" : "14px");
  assert.equal(headingStyles[0][1].lineHeight, mobile ? "16px" : "20px");
  assert.equal(headingStyles[0][1].color, mobile ? headingStyles[1][0].color : headingStyles[0][0].color);
  assert.equal(headingStyles[3][0].fontSize, "12px");
  assert.equal(headingStyles[3][1].fontSize, "12px");
  assert.equal(headingStyles[4][0].fontSize, "18px");
  assert.equal(headingStyles[4][1].fontSize, "18px");
  assert.equal(headingStyles[4][1].color, headingStyles[4][0].color);
}

async function checkTimeFormatControl(page, expected) {
  const group = page.locator("header").first().getByRole("radiogroup", { name: "Time format" });
  assert.equal(await group.count(), 1);
  assert.equal(await group.getByRole("radio", { checked: true }).textContent(), expected.checked);
  const bounds = await group.evaluate((node) => ({
    right: node.getBoundingClientRect().right,
    headerRight: node.closest("header").getBoundingClientRect().right,
    radius: getComputedStyle(node).borderRadius,
  }));
  assert.equal(bounds.right, bounds.headerRight);
  if (expected.square) assert.equal(bounds.radius, "0px");
}

async function checkTimeRows(page, buttons, viewport, expected) {
  await buttons.first().waitFor();
  assert.deepEqual(await buttons.allTextContents(), expected.labels);
  await checkTimeHeadings(page, viewport, expected.firstHeader);
  assert.equal(await buttons.nth(1).isDisabled(), expected.disabledSecond);
  assert.equal(await buttons.first().isDisabled(), expected.disabledFirst);
  assert.equal(
    await page.locator('[data-testid="time"].border-brand-default').count(),
    expected.selectedCount
  );
  if (expected.format) await checkTimeFormatControl(page, expected.format);
}

async function checkTimeSelection(page, buttons, expected) {
  if (expected.disabledSecond) {
    await buttons.nth(1).evaluate((button) => button.click());
    assert.equal(await page.getByTestId("selection").textContent(), "none");
  }
  if (expected.format) {
    const group = page.locator("header").first().getByRole("radiogroup", { name: "Time format" });
    await group.getByRole("radio", { name: "24h", exact: true }).click();
    assert.deepEqual(await buttons.allTextContents(), ["09:00", "12:30", "23:00"]);
    await group.getByRole("radio", { name: "12h", exact: true }).click();
    assert.deepEqual(await buttons.allTextContents(), ["9:00am", "12:30pm", "11:00pm"]);
  }
  if (!expected.disabledFirst) {
    await buttons.first().click();
    assert.equal(await page.getByTestId("selection").textContent(), "2030-01-10T09:00:00Z");
    await buttons.nth(2).focus();
    await buttons.nth(2).press("Enter");
    assert.equal(await page.getByTestId("selection").textContent(), "2030-01-10T23:00:00Z");
  }
}

async function verifyTimeScenario({
  browser,
  origin,
  artifacts,
  differentPixels,
  name,
  viewport,
  theme,
  scenario,
}) {
  const captures = [];
  for (const version of ["reference", "candidate"]) {
    const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC" });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.clock.setFixedTime(new Date("2030-01-09T12:00:00Z"));
      if (scenario.kind === "skeleton")
        await page.addInitScript((value) => {
          Math.random = () => value;
        }, scenario.random);
      const entry = version === "reference" ? "times.html" : "candidate-times.html";
      await page.goto(`${origin}/${entry}?case=${scenario.name}&theme=${theme}`);
      const buttons = page.getByTestId("time");
      if (scenario.kind === "skeleton") {
        await checkTimeSkeletons(page, scenario);
      } else {
        await checkTimeRows(page, buttons, viewport, scenario);
      }
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      captures.push(
        Array.from(
          await page.screenshot({
            path: fileURLToPath(new URL(`${version}-times-${name}-${theme}-${scenario.name}.png`, artifacts)),
            fullPage: true,
          })
        )
      );
      if (version === "candidate")
        assert.equal(
          await page.evaluate(differentPixels, captures),
          0,
          `times ${name}/${theme}/${scenario.name} pixels`
        );
      if (scenario.kind === "rows") await checkTimeSelection(page, buttons, scenario);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

export async function verifyTimes(browser, origin, artifacts, differentPixels) {
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
    ["mobile-boundary", { width: 768, height: 900 }],
    ["desktop-boundary", { width: 769, height: 900 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const scenario of timeScenarios) {
        if (name.endsWith("boundary") && !["twelve", "format-custom"].includes(scenario.name)) continue;
        await verifyTimeScenario({
          browser,
          origin,
          artifacts,
          differentPixels,
          name,
          viewport,
          theme,
          scenario,
        });
      }
    }
  }
  console.log(
    "PASS ordinary time rows, responsive headings with optional clock controls and loading skeletons match pinned source with zero different pixels in 56 desktop/mobile/boundary and light/dark comparisons, including native selection and timezone/clock formatting."
  );
}
