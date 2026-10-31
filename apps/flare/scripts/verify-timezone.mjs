import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

async function verifyTimezoneVersion(
  browser,
  { viewport, origin, theme, version, artifacts, name, captures }
) {
  const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC" });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.clock.setFixedTime(new Date("2030-01-09T12:00:00Z"));
    const url = `${origin}/timezone.html?theme=${theme}${version === "candidate" ? "&candidate" : ""}`;
    await page.goto(url);
    const control = page.getByRole("combobox", { name: "Timezone Select", exact: true });
    await control.waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const state of Object.keys(captures)) {
      if (state === "search") {
        await page.getByRole("button", { name: "Before", exact: true }).focus();
        await page.keyboard.press("Tab");
        await expect(control).toBeFocused();
        await control.fill("Kolkata");
        await page.getByRole("option", { name: "Kolkata GMT +05:30", exact: true }).waitFor();
      }
      if (state === "selected") {
        await control.press("ArrowDown");
        await control.press("Enter");
        assert.equal(await page.getByLabel("Selected timezone").textContent(), "Asia/Kolkata");
        await control.blur();
      }
      if (state === "checked") {
        await control.fill("Kolkata");
        assert.equal(
          await page.getByRole("option", { name: "Kolkata GMT +05:30", exact: true }).locator("svg").count(),
          1
        );
      }
      if (state === "disabled") {
        await page.goto(`${url}&selected&disabled`);
        await expect(page.getByLabel("Timezone Select", { exact: true })).toBeDisabled();
        await page.evaluate(() => document.fonts.ready);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      captures[state].push(
        Array.from(
          await page.screenshot({
            path: fileURLToPath(new URL(`${version}-timezone-${name}-${theme}-${state}.png`, artifacts)),
            fullPage: true,
            animations: "disabled",
          })
        )
      );
    }
    await verifyTimezoneSearchAndAliases(page, control, url);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function verifyTimezoneSearchAndAliases(page, control, url) {
  await page.goto(url);
  await control.fill("no-matching-timezone");
  await page.getByText("No options", { exact: true }).waitFor();
  await control.press("Escape");
  assert.equal(await control.getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByLabel("Selected timezone").textContent(), "UTC");
  await control.fill("India");
  await page.getByRole("option", { name: "India Standard Time GMT +05:30", exact: true }).click();
  assert.equal(await page.getByLabel("Selected timezone").textContent(), "Asia/Kolkata");
}

export async function verifyTimezone(browser, origin, artifacts, differentPixels) {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      const captures = { rest: [], search: [], selected: [], checked: [], disabled: [] };
      for (const version of ["reference", "candidate"]) {
        await verifyTimezoneVersion(browser, {
          viewport,
          origin,
          theme,
          version,
          artifacts,
          name,
          captures,
        });
      }
      const page = await browser.newPage();
      try {
        for (const [state, pair] of Object.entries(captures))
          assert.equal(
            await page.evaluate(differentPixels, pair),
            0,
            `${name}/${theme}/${state} timezone pixels`
          );
      } finally {
        await page.close();
      }
    }
  }
  console.log(
    "PASS timezone search, aliases, Tab/Enter, Escape, checked/disabled states and 20 exact pixel pairs."
  );
}
