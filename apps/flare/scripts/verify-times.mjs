import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export async function verifyTimes(browser, origin, artifacts, differentPixels) {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const scenario of [
        "twelve",
        "twentyfour",
        "zone",
        "selected",
        "unavailable",
        "loading",
        "format-twelve",
        "format-twentyfour",
        "format-custom",
        "skeleton-1",
        "skeleton-4",
        "skeleton-6",
      ]) {
        const skeletonCount = Number(scenario.split("-")[1]) || 0;
        const formatHeader = scenario.startsWith("format-");
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
            await page.clock.install({ time: new Date("2030-01-09T12:00:00Z") });
            if (skeletonCount)
              await page.addInitScript((value) => {
                Math.random = () => value;
              }, { 1: 0, 4: 0.5, 6: 0.999999 }[skeletonCount]);
            const entry = version === "reference" ? "times.html" : "candidate-times.html";
            await page.goto(`${origin}/${entry}?case=${scenario}&theme=${theme}`);
            const buttons = page.getByTestId("time");
            if (skeletonCount) {
              const placeholders = page.locator("main span.animate-pulse");
              await placeholders.first().waitFor();
              assert.equal(await placeholders.count(), skeletonCount);
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
            } else {
              await buttons.first().waitFor();
              let expected = ["9:00am", "12:30pm", "11:00pm"];
              if (scenario.endsWith("twentyfour")) expected = ["09:00", "12:30", "23:00"];
              if (scenario === "zone") expected = ["2:30pm", "6:00pm", "4:30am"];
              assert.deepEqual(await buttons.allTextContents(), expected);
              assert.deepEqual(await page.locator("main header").allTextContents(), [
                formatHeader ? "Wed0912h24h" : "Wed09",
                "Thu10",
                "Fri11, January",
                "Sat12",
              ]);
              assert.equal(await buttons.nth(1).isDisabled(), ["loading", "unavailable"].includes(scenario));
              assert.equal(await buttons.first().isDisabled(), scenario === "loading");
              assert.equal(
                await page.locator('[data-testid="time"].border-brand-default').count(),
                scenario === "selected" ? 1 : 0
              );
              if (formatHeader) {
                const group = page.locator("header").first().getByRole("radiogroup", { name: "Time format" });
                assert.equal(await group.count(), 1);
                assert.equal(
                  await group.getByRole("radio", { checked: true }).textContent(),
                  scenario.endsWith("twentyfour") ? "24h" : "12h"
                );
                const bounds = await group.evaluate((node) => ({
                  right: node.getBoundingClientRect().right,
                  headerRight: node.closest("header").getBoundingClientRect().right,
                  radius: getComputedStyle(node).borderRadius,
                }));
                assert.equal(bounds.right, bounds.headerRight);
                if (scenario === "format-custom") assert.equal(bounds.radius, "0px");
              }
            }
            await page.addStyleTag({
              content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
            });
            await page.evaluate(() => document.fonts.ready);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            captures.push(
              Array.from(
                await page.screenshot({
                  path: fileURLToPath(
                    new URL(`${version}-times-${name}-${theme}-${scenario}.png`, artifacts)
                  ),
                  fullPage: true,
                })
              )
            );
            if (version === "candidate")
              assert.equal(
                await page.evaluate(differentPixels, captures),
                0,
                `times ${name}/${theme}/${scenario} pixels`
              );
            if (["loading", "unavailable"].includes(scenario)) {
              await buttons.nth(1).evaluate((button) => button.click());
              assert.equal(await page.getByTestId("selection").textContent(), "none");
            }
            if (formatHeader) {
              const group = page.locator("header").first().getByRole("radiogroup", { name: "Time format" });
              await group.getByRole("radio", { name: "24h", exact: true }).click();
              assert.deepEqual(await buttons.allTextContents(), ["09:00", "12:30", "23:00"]);
              await group.getByRole("radio", { name: "12h", exact: true }).click();
              assert.deepEqual(await buttons.allTextContents(), ["9:00am", "12:30pm", "11:00pm"]);
            }
            if (!skeletonCount && scenario !== "loading") {
              await buttons.first().click();
              assert.equal(await page.getByTestId("selection").textContent(), "2030-01-10T09:00:00Z");
              await buttons.nth(2).focus();
              await buttons.nth(2).press("Enter");
              assert.equal(await page.getByTestId("selection").textContent(), "2030-01-10T23:00:00Z");
            }
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        }
      }
    }
  }
  console.log(
    "PASS ordinary time rows, headings with optional clock controls and loading skeletons match pinned source with zero different pixels in 48 desktop/mobile and light/dark comparisons, including native selection and timezone/clock formatting."
  );
}
