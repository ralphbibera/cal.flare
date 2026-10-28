import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

async function expectEdges(page, top, bottom) {
  await page.waitForFunction(
    ([top, bottom]) => {
      const region = document.querySelector('[aria-label="Long description"]');
      const overlays = [...region.parentElement.querySelectorAll(':scope > [aria-hidden="true"]')];
      const rect = region.getBoundingClientRect();
      return (
        overlays.length === Number(top) + Number(bottom) &&
        overlays.some((node) => node.getBoundingClientRect().top === rect.top) === top &&
        overlays.some((node) => node.getBoundingClientRect().bottom === rect.bottom) === bottom
      );
    },
    [top, bottom]
  );
}

export async function verifyMeta(browser, origin, artifacts, differentPixels) {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      const captures = { top: [], middle: [], bottom: [] };
      for (const version of ["reference", "candidate"]) {
        const context = await browser.newContext({ viewport });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          await page.goto(`${origin}/meta.html?theme=${theme}${version === "candidate" ? "&candidate" : ""}`);
          await page.getByTestId("props").waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(
            () =>
              [...document.querySelectorAll("main svg")].every((icon) => icon.getBBox().width > 0) &&
              [...document.querySelectorAll("main img")].every(
                (image) => image.complete && image.naturalWidth > 0
              )
          );
          assert.equal(await page.getByTestId("empty").count(), 0);
          assert.equal(await page.getByTestId("zero").textContent(), "0");
          assert.equal(await page.locator("main > div").count(), 19);
          for (const [index, text] of [
            null,
            null,
            "1m",
            "30m",
            "59m",
            "1h",
            "1h 1m",
            "1h 30m",
            "2h",
            "2h 1m",
            "8h",
          ].entries()) {
            const duration = page.getByTestId(`duration-${index}`);
            if (text === null) assert.equal(await duration.count(), 0);
            else assert.equal(await duration.textContent(), text);
          }
          assert.equal(await page.locator("main img").count(), 3);
          assert.equal(await page.getByTestId("custom").locator("svg").count(), 0);
          assert.equal(
            await page.getByRole("group", { name: "Metadata props" }).getAttribute("title"),
            "Forwarded title"
          );
          const short = page.getByRole("region", { name: "Short description", exact: true });
          assert.ok(await short.evaluate((node) => node.scrollHeight <= node.clientHeight));
          assert.equal(await short.locator("..").locator(':scope > [aria-hidden="true"]').count(), 0);
          const long = page.getByRole("region", { name: "Long description", exact: true });
          assert.equal(await long.getAttribute("tabindex"), "0");
          assert.ok(await long.evaluate((node) => node.scrollHeight > node.clientHeight));
          await expectEdges(page, false, true);
          await long.focus();
          assert.ok(await long.evaluate((node) => document.activeElement === node));
          for (const [offset, top, bottom] of [
            [5, false, true],
            [6, true, true],
            [-6, true, true],
            [-5, true, false],
          ]) {
            await long.evaluate((node, offset) => {
              node.scrollTop = offset < 0 ? node.scrollHeight - node.clientHeight + offset : offset;
            }, offset);
            await expectEdges(page, top, bottom);
          }
          await long.press("Home");
          await page.waitForFunction(
            () => document.querySelector('[aria-label="Long description"]').scrollTop === 0
          );
          for (const state of ["top", "middle", "bottom"]) {
            if (state === "middle")
              await long.evaluate((node) => {
                node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
              });
            if (state === "bottom") {
              await long.press("End");
              await page.waitForFunction(() => {
                const node = document.querySelector('[aria-label="Long description"]');
                return node.scrollTop === node.scrollHeight - node.clientHeight;
              });
            }
            await expectEdges(page, state !== "top", state !== "bottom");
            await long.blur();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            const suffix = state === "top" ? "" : `-${state}`;
            captures[state].push([
              ...(await page.screenshot({
                path: fileURLToPath(new URL(`${version}-meta-${name}-${theme}${suffix}.png`, artifacts)),
                fullPage: true,
                animations: "disabled",
              })),
            ]);
            if (version === "candidate")
              assert.equal(
                await page.evaluate(differentPixels, captures[state]),
                0,
                `${name}/${theme}/${state} metadata pixels`
              );
          }
          assert.ok(
            await long
              .locator("..")
              .locator(':scope > [aria-hidden="true"]')
              .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).pointerEvents === "none"))
          );
          await page.getByRole("button", { name: "Expand description", exact: true }).click();
          await expectEdges(page, false, false);
          assert.ok(await long.evaluate((node) => node.scrollHeight === node.clientHeight));
          await page.getByRole("button", { name: "Collapse description", exact: true }).click();
          await expectEdges(page, false, true);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log(
    "PASS metadata, duration and scroll gradients match pinned source with zero different pixels in 12 desktop/mobile, light/dark, top/middle/bottom comparisons; threshold boundaries, keyboard scrolling and resize pass."
  );
}
