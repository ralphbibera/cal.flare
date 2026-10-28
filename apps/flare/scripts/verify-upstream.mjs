import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

async function ready(page, selector) {
  await page.locator(selector).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () =>
      document.images.length > 0 &&
      [...document.images].every((image) => image.complete && image.naturalWidth > 0)
  );
  await page.evaluate(async (selector) => {
    let previous = "";
    let stable = 0;
    for (let frame = 0; frame < 900; frame++) {
      await new Promise(requestAnimationFrame);
      const node = document.querySelector(selector);
      if (!node) throw new Error("Reference control disappeared");
      const target = node.getBoundingClientRect();
      const rectangles = [];
      let valid = !document
        .getAnimations()
        .some((animation) => ["running", "pending"].includes(animation.playState));
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const rect = ancestor.getBoundingClientRect();
        const style = getComputedStyle(ancestor);
        if (Number(style.opacity) !== 1 || !["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(style.transform))
          valid = false;
        if (
          ["hidden", "clip", "auto", "scroll"].includes(style.overflowX) &&
          (target.left < rect.left || target.right > rect.right)
        )
          valid = false;
        rectangles.push([rect.x, rect.y, rect.width, rect.height]);
      }
      const signature = JSON.stringify(rectangles);
      stable = valid && signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable === 3) return;
    }
    throw new Error("Reference geometry or animations did not settle");
  }, selector);
}

export async function verifyUpstream(browser, origin, artifacts, differentPixels) {
  assert.equal(origin, "http://127.0.0.1:18800", "Use the disposable pinned reference fixture");
  const captures = [];
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const take of [1, 2]) {
      const context = await browser.newContext({
        viewport,
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
      });
      const errors = [];
      const failures = [];
      const consoleErrors = [];
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date("2030-01-09T12:00:00Z"));
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => {
          if (response.status() >= 400) failures.push(new URL(response.url()).pathname);
        });
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        const response = await page.goto(`${origin}/reference/intro`);
        assert.equal(response.status(), 200);
        await page.mouse.move(0, 0);
        await ready(page, '[data-testid="time"]');
        assert.equal(await page.getByTestId("time").count(), 9);
        assert.equal(await page.getByTestId("time").first().textContent(), "12:30pm");
        assert.equal(await page.getByTestId("time").last().textContent(), "4:30pm");
        assert.equal(
          await page.getByRole("button", { name: /Open Next.js Dev Tools|Collapse issues badge/ }).count(),
          0
        );
        assert.ok(
          await page.evaluate(() =>
            [...document.fonts].some((font) => font.family === "Inter" && font.status === "loaded")
          )
        );
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const calendar = [
          ...(await page.screenshot({
            path: fileURLToPath(new URL(`upstream-${name}-calendar-${take}.png`, artifacts)),
            fullPage: true,
            animations: "disabled",
          })),
        ];
        await page.getByRole("button", { name: "10", exact: true }).click();
        await page.mouse.move(0, 0);
        await ready(page, '[data-testid="time"]');
        assert.equal(await page.getByTestId("time").count(), 16);
        assert.equal(await page.getByTestId("time").first().textContent(), "9:00am");
        const reserved = page.waitForResponse(
          (item) => new URL(item.url()).pathname === "/api/trpc/slots/reserveSlot"
        );
        await page.getByTestId("time").first().click();
        const reservation = await reserved;
        assert.equal(reservation.status(), 200);
        assert.equal(reservation.request().postDataJSON().json.slotUtcStartDate, "2030-01-10T09:00:00.000Z");
        const input = page.getByLabel(/Your name/);
        await input.waitFor();
        await page.mouse.move(0, 0);
        await ready(page, `[id=${JSON.stringify(await input.getAttribute("id"))}]`);
        assert.ok((await page.locator("body").innerText()).includes("Thursday, January 10, 2030"));
        assert.equal(await page.getByRole("dialog").count(), name === "mobile" ? 1 : 0);
        if (name === "mobile") {
          assert.ok(
            await page.evaluate(() =>
              [...document.fonts].some((font) => font.family === "calFont" && font.status === "loaded")
            )
          );
        }
        const form = [
          ...(await page.screenshot({
            path: fileURLToPath(new URL(`upstream-${name}-form-${take}.png`, artifacts)),
            fullPage: true,
            animations: "disabled",
          })),
        ];
        assert.deepEqual(errors, []);
        assert.deepEqual(failures, []);
        assert.deepEqual(consoleErrors, []);
        captures.push({ name, calendar, form });
        console.log(`Reference ${name}/${take}: no uncaught errors, console errors or HTTP failures.`);
      } finally {
        try {
          const response = await context.request.post(`${origin}/api/trpc/slots/removeSelectedSlotMark`, {
            headers: { Origin: origin },
            data: { json: { uid: null } },
          });
          assert.equal(response.status(), 200, "Reference reservation cleanup");
        } finally {
          await context.close();
        }
      }
    }
  }
  const comparison = await browser.newPage();
  try {
    for (const name of ["desktop", "mobile"]) {
      const pair = captures.filter((capture) => capture.name === name);
      for (const state of ["calendar", "form"]) {
        assert.equal(
          await comparison.evaluate(
            differentPixels,
            pair.map((capture) => capture[state])
          ),
          0,
          `upstream ${name}/${state} repeat pixels`
        );
      }
    }
  } finally {
    await comparison.close();
  }
  console.log(
    "PASS actual pinned public-page static reference repeats exactly at desktop/mobile, including slot selection, inline form and mobile dialog. No candidate-page parity is established."
  );
}
