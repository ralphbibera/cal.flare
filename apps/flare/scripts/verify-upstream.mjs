import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { verifyColumnPage } from "./verify-column-page.mjs";
import { verifyNativeConfirmation } from "./verify-native-confirmation.mjs";
import { createWorkerFixture } from "./verify-worker.mjs";

const fixedTime = Date.parse("2030-01-09T12:00:00Z");

async function verifyDialogComposition(page) {
  const dialog = page.getByRole("dialog", { name: "Confirm your details", exact: true });
  assert.equal(await dialog.locator("form").count(), 1);
  assert.equal(await dialog.locator("time").getAttribute("datetime"), "2030-01-10T09:00:00.000Z");
  assert.equal(await dialog.locator("time").textContent(), "Thursday, January 10, 2030, 9:00 am");
  assert.ok(await dialog.getByText("UTC", { exact: true }).isVisible());
  assert.ok(await dialog.getByText("30m", { exact: true }).isVisible());
  assert.ok(await dialog.getByRole("button", { name: "Add guests", exact: true }).isVisible());
  const terms = dialog.getByRole("link", { name: "Terms", exact: true });
  const privacy = dialog.getByRole("link", { name: "Privacy Policy", exact: true });
  assert.equal(
    await terms.evaluate((node) => node.parentElement.textContent),
    "By proceeding, you agree to Cal.diy's Terms and Privacy Policy."
  );
  for (const [link, href] of [
    [terms, "https://cal.com/terms"],
    [privacy, "https://cal.com/privacy"],
  ]) {
    assert.equal(await link.getAttribute("href"), href);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  }
  const footer = dialog.getByRole("button", { name: "Back", exact: true }).locator("..");
  assert.deepEqual(
    await footer.evaluate((node) => {
      const style = getComputedStyle(node);
      return [
        style.position,
        style.bottom,
        style.backgroundColor,
        style.borderTopWidth,
        style.borderTopColor,
        style.padding,
        style.marginLeft,
        style.marginRight,
      ];
    }),
    ["sticky", "0px", "rgb(255, 255, 255)", "1px", "rgb(229, 231, 235)", "16px 32px", "-32px", "-32px"]
  );
  assert.ok(
    await dialog.evaluate((node) => {
      const nodes = [
        node.querySelector('input[name="name"]'),
        node.querySelector('input[name="email"]'),
        node.querySelector("textarea"),
        [...node.querySelectorAll("button")].find((n) => n.textContent === "Add guests"),
        node.querySelector("a"),
        node.querySelector('button[type="submit"]'),
      ];
      return (
        nodes.every(
          (item, index) =>
            !index ||
            Boolean(nodes[index - 1].compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING)
        ) &&
        node.scrollWidth <= node.clientWidth &&
        document.documentElement.scrollWidth <= innerWidth
      );
    }),
    "Fields, closed guests, agreement and actions keep logical order without horizontal overflow"
  );
}

async function captureDialogRegions(page, artifacts, name) {
  const dialog = page.getByRole("dialog");
  const appointment = dialog.locator("h1 + div > div");
  assert.deepEqual(await appointment.allTextContents(), ["Thursday, January 10, 2030, 9:00 am", "30m"]);
  assert.deepEqual(
    await dialog
      .locator('input[name="name"], input[name="email"], textarea[name="notes"]')
      .evaluateAll((nodes) => nodes.map((node) => node.value)),
    ["", "", ""]
  );
  assert.equal(await dialog.getByRole("button", { name: "Add guests", exact: true }).count(), 1);
  const agreement = dialog.getByRole("link", { name: "Terms", exact: true }).locator("..");
  assert.equal(
    await agreement.textContent(),
    "By proceeding, you agree to Cal.diy's Terms and Privacy Policy."
  );
  const footer = dialog.getByRole("button", { name: "Back", exact: true }).locator("..");
  const regions = {};
  for (const [part, locator] of [
    ["badges", appointment],
    ["agreement", agreement],
    ["footer", footer],
  ]) {
    const bounds = await locator.evaluateAll((nodes) => {
      const rects = nodes.map((node) => node.getBoundingClientRect());
      const x = Math.min(...rects.map((r) => r.x)),
        y = Math.min(...rects.map((r) => r.y));
      return {
        x,
        y,
        width: Math.max(...rects.map((r) => r.right)) - x,
        height: Math.max(...rects.map((r) => r.bottom)) - y,
      };
    });
    const styles = await locator.evaluateAll(
      (nodes, part) =>
        nodes.map((node) => {
          const s = getComputedStyle(node);
          const pixel = document.createElement("canvas").getContext("2d");
          const color = (value) => {
            pixel.clearRect(0, 0, 1, 1);
            pixel.fillStyle = value;
            pixel.fillRect(0, 0, 1, 1);
            return [...pixel.getImageData(0, 0, 1, 1).data];
          };
          return [
            s.fontSize,
            s.fontWeight,
            s.lineHeight,
            color(s.backgroundColor),
            part === "footer"
              ? [...node.querySelectorAll("button")].map((button) => color(getComputedStyle(button).color))
              : color(s.color),
            s.borderRadius,
            s.padding,
            s.borderTopWidth,
          ];
        }),
      part
    );
    if (part === "badges")
      assert.deepEqual(
        styles.map((style) => [style[0], style[1], style[2], style[5], style[6]]),
        [
          ["14px", "500", "14px", "10px", "4px 6px"],
          ["14px", "500", "14px", "10px", "4px 6px"],
        ],
        "Pinned large gray badge typography, radius and padding"
      );
    regions[part] = {
      size: [bounds.width, bounds.height],
      styles,
      pixels: [
        ...(await page.screenshot({
          clip: bounds,
          path: fileURLToPath(new URL(`${name}-${part}.png`, artifacts)),
          animations: "disabled",
        })),
      ],
    };
  }
  return regions;
}

async function verifyDefaultDialogs(browser) {
  const fixture = await createWorkerFixture({ port: 8798, fixedTime });
  try {
    const owner = await fixture.login();
    const settings = {
      ...fixture.settings,
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
      },
    };
    assert.equal((await fixture.send("/api/owner", settings, owner, "PUT")).status, 200);
    for (const width of [390, 768, 900, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
      });
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date(fixedTime));
        await page.goto(`${fixture.origin}/${fixture.settings.event.slug}`);
        await page.getByRole("button", { name: "10", exact: true }).click();
        if (width > 768)
          await page
            .getByRole("radio", {
              name: width === 900 ? "Switch to weekly view" : "Switch to column view",
              exact: true,
            })
            .click();
        await (width === 900
          ? page.locator('[data-slot="2030-01-10T09:00:00.000Z"]')
          : page.getByTestId("time").first()
        ).click();
        await verifyDialogComposition(page);
        assert.deepEqual(
          await page.locator("form input, form textarea").evaluateAll((nodes) => nodes.map((n) => n.value)),
          ["", "", ""]
        );
        await page.screenshot({
          path: fileURLToPath(new URL(`../.verification/dialog-composition-${width}.png`, import.meta.url)),
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    }
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    assert.equal(fixture.google.writes.length, 0);
  } finally {
    await fixture.close();
  }
  console.log(
    "PASS default blank dialog composition at 390/768/900/1280, literal UTC appointment, duration, agreement links, logical order and sticky footer. Built Worker/local D1; Google is mocked."
  );
}

async function captureAttendeeRegion(page, artifacts, name) {
  await ready(page, 'input[name="email"]');
  const guests = page.getByRole("button", { name: "Add guests", exact: true });
  const metrics = await guests.evaluate((button) => {
    const form = button.closest("form");
    const name = form.querySelector('input[name="name"]');
    const email = form.querySelector('input[name="email"]');
    const notes = form.querySelector('textarea[name="notes"]');
    const rect = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const fields = [name, email, notes].map((node) => {
      const label = node.labels[0];
      const style = getComputedStyle(node);
      return {
        label: label.textContent,
        labelBounds: rect(label),
        bounds: rect(node),
        value: node.value,
        font: [style.fontSize, style.fontWeight, style.lineHeight],
        marker: label.querySelector("span:last-child")?.textContent,
      };
    });
    const rectangles = [email.labels[0], email, notes.labels[0], notes, button].map(rect);
    const x = Math.min(...rectangles.map((item) => item.x));
    const y = Math.min(...rectangles.map((item) => item.y));
    return {
      fields,
      guests: rect(button),
      guestInputs: form.querySelectorAll('input[name^="guests."]').length,
      nameRequired: name.required,
      card: rect(document.querySelector('[data-testid="booker-container"]')),
      panel: rect(form.closest("section, [data-testid='booker-container'] > div")),
      form: rect(form),
      boundary: {
        x,
        y,
        width: Math.max(...rectangles.map((item) => item.x + item.width)) - x,
        height: Math.max(...rectangles.map((item) => item.y + item.height)) - y,
      },
    };
  });
  const pixels = [
    ...(await page.screenshot({
      path: fileURLToPath(new URL(`${name}-email-closed-guests.png`, artifacts)),
      clip: metrics.boundary,
      animations: "disabled",
    })),
  ];
  assert.deepEqual(metrics.boundary, { x: 625, y: 296, width: 371, height: 236 }, `${name} partial boundary`);
  assert.deepEqual(metrics.card, { x: 260, y: 201, width: 760, height: 450 });
  assert.deepEqual(metrics.panel, { x: 600, y: 202, width: 420, height: 448 });
  assert.deepEqual(metrics.form, { x: 625, y: 226, width: 371, height: 400 });
  assert.deepEqual(
    metrics.fields.map((field) => field.label),
    ["Your name*", "Email address*", "Additional notes"]
  );
  assert.deepEqual(
    metrics.fields.map((field) => field.value),
    ["", "", ""]
  );
  assert.deepEqual(
    metrics.fields.map((field) => field.marker),
    ["*", "*", ""]
  );
  assert.deepEqual(
    metrics.fields.map((field) => field.labelBounds.y),
    [226, 296, 366]
  );
  assert.deepEqual(
    metrics.fields.slice(1).map((field) => field.labelBounds.width),
    [104.625, 112.296875]
  );
  assert.deepEqual(
    metrics.fields.map((field) => field.bounds),
    [
      { x: 625, y: 248, width: 371, height: 32 },
      { x: 625, y: 318, width: 371, height: 32 },
      { x: 625, y: 388, width: 371, height: 80 },
    ]
  );
  assert.deepEqual(
    metrics.fields.map((field) => field.font),
    [
      ["14px", "500", "14px"],
      ["14px", "500", "14px"],
      ["14px", "400", "20px"],
    ]
  );
  assert.deepEqual(metrics.guests, { x: 625, y: 498, width: 117.90625, height: 34 });
  assert.equal(metrics.guestInputs, 0);
  assert.equal(metrics.nameRequired, true);
  assert.equal(await page.getByTestId("event-title").textContent(), "Intro call");
  assert.equal(await page.getByText("A short conversation.", { exact: true }).count(), 1);
  assert.ok((await page.getByText("Organizer", { exact: true }).count()) > 0);
  assert.ok((await page.locator("body").innerText()).includes("Thursday, January 10, 2030"));
  console.log(`PASS ${name} literal blank desktop month form geometry, labels, markers and fonts.`);
  return pixels;
}

async function measureFrame(page) {
  const bounds = await page.getByTestId("booker-container").boundingBox();
  assert.ok(bounds);
  return {
    bounds,
    documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
    background: await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
  };
}

async function measureSelectedDay(page) {
  const day = page.getByTestId("day").filter({ hasText: /^9Today$/ });
  return day.evaluate((button) => ({
    background: getComputedStyle(button).backgroundColor,
    text: getComputedStyle(button).color,
    todayMarker: getComputedStyle(button.querySelector("span")).backgroundColor,
  }));
}

async function readFont(page, locator = page.locator("body"), expectedFace) {
  const asset = await locator.evaluate((node) => {
    const family = getComputedStyle(node).fontFamily.split(",")[0].replaceAll('"', "").trim();
    const loaded = [...document.fonts].some(
      (font) => font.family.replaceAll('"', "") === family && font.status === "loaded"
    );
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (
          rule.type === CSSRule.FONT_FACE_RULE &&
          rule.style.getPropertyValue("font-family").replaceAll('"', "") === family &&
          (!rule.style.getPropertyValue("unicode-range") ||
            rule.style.getPropertyValue("unicode-range").startsWith("U+0-FF,"))
        ) {
          const source = /url\("([^"]+)"\)/.exec(rule.style.getPropertyValue("src"));
          if (source)
            return {
              url: new URL(source[1], sheet.href || location.href).href,
              loaded,
              face: {
                family,
                style: rule.style.getPropertyValue("font-style") || "normal",
                weight: rule.style.getPropertyValue("font-weight"),
                display: rule.style.getPropertyValue("font-display"),
              },
            };
        }
      }
    }
    throw new Error("Rendered first font family has no Latin font asset");
  });
  assert.ok(asset.loaded, "Rendered first font family has a loaded document.fonts face");
  if (expectedFace) assert.deepEqual(asset.face, expectedFace, "Rendered font face recipe");
  const response = await page.request.get(asset.url);
  assert.equal(response.status(), 200, "Rendered font asset response");
  return response.body();
}

async function measureTitle(page, locator = page.getByTestId("event-title")) {
  return locator.evaluate((title) => {
    const range = document.createRange();
    range.selectNodeContents(title);
    const bounds = range.getBoundingClientRect();
    const style = getComputedStyle(title);
    return {
      width: bounds.width,
      height: bounds.height,
      size: style.fontSize,
      weight: style.fontWeight,
      spacing: style.letterSpacing,
      lineHeight: style.lineHeight,
    };
  });
}

async function verifyDialogTypography(page, family = "Cal Sans Booking") {
  await page.evaluate(() => document.fonts.ready);
  const heading = page.getByRole("heading", { name: "Confirm your details", exact: true });
  const font = await readFont(page, heading, { family, style: "normal", weight: "600", display: "block" });
  assert.equal(font.length, 40932, "Pinned Cal Sans served byte length");
  assert.equal(
    createHash("sha256").update(font).digest("hex"),
    "d3e38c946c6c0299f321b6cf2c92f7f26e202530f49d6bc86d52e9fd74f393a2",
    "Pinned Cal Sans served identity"
  );
  const metrics = await measureTitle(page, heading);
  const source = await readFile(new URL("../../web/fonts/CalSans-SemiBold.woff2", import.meta.url));
  assert.ok(font.equals(source), "Dialog font matches pinned source bytes");
  const reference = await page.context().newPage();
  try {
    await reference.setContent(
      '<h2 style="font-family: PinnedCalSans; font-size: 20px; font-weight: 400; letter-spacing: normal; line-height: 20px">Confirm your details</h2>'
    );
    await reference.evaluate(
      async (bytes) => {
        const face = new FontFace("PinnedCalSans", new Uint8Array(bytes), {
          style: "normal",
          weight: "600",
          display: "block",
        });
        document.fonts.add(await face.load());
      },
      [...source]
    );
    assert.deepEqual(
      metrics,
      await measureTitle(reference, reference.getByRole("heading")),
      "Dialog text metrics match independently loaded pinned Cal Sans in this browser"
    );
  } finally {
    await reference.close();
  }
  console.log(`PASS ${family} loaded dialog font: 40932 bytes; heading ${JSON.stringify(metrics)}`);
  return { font, metrics };
}

async function measureTimeList(page) {
  return page
    .getByTestId("time")
    .first()
    .evaluate((button) => {
      for (let node = button.parentElement; node; node = node.parentElement) {
        if (!["auto", "scroll"].includes(getComputedStyle(node).overflowY)) continue;
        const bounds = node.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
        };
      }
      throw new Error("Time list has no scroll container");
    });
}

export async function ready(page, selector) {
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
        await page.clock.setFixedTime(new Date(fixedTime));
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
        await page.waitForFunction(() => {
          const description = document.querySelector(
            '[data-testid="event-meta-description"] [role="region"]'
          );
          return (
            description &&
            description.scrollHeight <= description.clientHeight &&
            !description.parentElement.querySelector('[aria-hidden="true"]')
          );
        });
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
        const frame = await measureFrame(page);
        const font = await readFont(page);
        const title = await measureTitle(page);
        const selectedDay = await measureSelectedDay(page);
        const timezone = [...(await page.locator(".current-timezone").screenshot())];
        const card = [...(await page.getByTestId("booker-container").screenshot())];
        assert.deepEqual(selectedDay, {
          background: "rgb(41, 41, 41)",
          text: "rgb(255, 255, 255)",
          todayMarker: "rgb(255, 255, 255)",
        });
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
        const fullDay = { frame: await measureFrame(page), timeList: await measureTimeList(page) };
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
        let dialog = null;
        let dialogRegions = null;
        if (name === "mobile") {
          dialog = await verifyDialogTypography(page, "calFont");
          dialogRegions = await captureDialogRegions(page, artifacts, `upstream-mobile-${take}`);
          await page.getByRole("heading", { name: "Confirm your details", exact: true }).screenshot({
            path: fileURLToPath(new URL(`upstream-mobile-heading-${take}.png`, artifacts)),
          });
        }
        const attendeeRegion =
          name === "desktop"
            ? await captureAttendeeRegion(page, artifacts, `upstream-desktop-${take}`)
            : null;
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
        captures.push({
          name,
          calendar,
          form,
          frame,
          viewport,
          selectedDay,
          font,
          title,
          fullDay,
          timezone,
          card,
          attendeeRegion,
          dialog,
          dialogRegions,
        });
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
  await verifyFlareFrames(browser, captures, artifacts, differentPixels);
  await verifyColumnPage(browser, origin, artifacts, differentPixels, ready);
  await verifyNativeConfirmation(browser, origin, artifacts, differentPixels);
}

async function verifyFlareFrames(browser, captures, artifacts, differentPixels) {
  const fixture = await createWorkerFixture({ port: 8797, fixedTime });
  try {
    const owner = await fixture.login();
    const settings = {
      ...fixture.settings,
      event: {
        ...fixture.settings.event,
        title: "Intro call",
        slug: "intro",
        description: "A short conversation.",
        durationMinutes: 30,
        intervalMinutes: 30,
        noticeMinutes: 1,
        beforeMinutes: 0,
        afterMinutes: 0,
      },
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          startMinute: 540,
          endMinute: 1020,
        })),
      },
    };
    assert.equal((await fixture.send("/api/owner", settings, owner, "PUT")).status, 200);
    for (const name of ["desktop", "mobile"]) {
      const reference = captures.find((capture) => capture.name === name);
      const context = await browser.newContext({
        viewport: reference.viewport,
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
        await page.clock.setFixedTime(new Date(fixedTime));
        assert.equal((await page.goto(`${fixture.origin}/intro`)).status(), 200);
        await ready(page, '[data-testid="time"]');
        assert.equal(await page.getByTestId("time").count(), 9);
        assert.equal(await page.getByTestId("time").first().textContent(), "12:30pm");
        assert.equal(await page.getByTestId("time").last().textContent(), "4:30pm");
        assert.ok((await readFont(page)).equals(reference.font), `${name} public served font bytes`);
        assert.deepEqual(await measureTitle(page), reference.title, `${name} public title text metrics`);
        assert.deepEqual(await measureFrame(page), reference.frame, `${name} public calendar frame`);
        assert.equal(
          await page.evaluate(differentPixels, [
            reference.card,
            [...(await page.getByTestId("booker-container").screenshot())],
          ]),
          0,
          `${name} initial booking-card pixels`
        );
        assert.equal(
          await page.evaluate(differentPixels, [
            reference.timezone,
            [...(await page.locator(".current-timezone").screenshot())],
          ]),
          0,
          `${name} actual timezone control pixels`
        );
        assert.deepEqual(
          await measureSelectedDay(page),
          reference.selectedDay,
          `${name} public selected-day colors`
        );
        const calendar = [
          ...(await page.screenshot({
            path: fileURLToPath(new URL(`candidate-page-${name}-calendar.png`, artifacts)),
            fullPage: true,
            animations: "disabled",
          })),
        ];
        if (name === "mobile")
          assert.equal(
            await page.evaluate(differentPixels, [reference.calendar, calendar]),
            0,
            "Initial mobile full-page pixels"
          );
        await page.getByRole("button", { name: "10", exact: true }).click();
        await ready(page, '[data-testid="time"]');
        assert.equal(await page.getByTestId("time").count(), 16);
        assert.deepEqual(await measureFrame(page), reference.fullDay.frame, `${name} full-day frame`);
        assert.deepEqual(await measureTimeList(page), reference.fullDay.timeList, `${name} time scroller`);
        const last = page.getByTestId("time").last();
        await last.focus();
        assert.ok(await last.evaluate((button) => document.activeElement === button));
        if (name === "desktop") {
          assert.ok(
            await last.evaluate((button) => {
              for (let node = button.parentElement; node; node = node.parentElement) {
                if (!["auto", "scroll"].includes(getComputedStyle(node).overflowY)) continue;
                const viewport = node.getBoundingClientRect();
                const bounds = button.getBoundingClientRect();
                return node.scrollTop > 0 && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
              }
              return false;
            }),
            "Native focus scrolls the final slot into the desktop time list"
          );
        }
        await last.press("Enter");
        await page.getByLabel("Your name*", { exact: true }).waitFor();
        assert.equal(
          await page.getByTestId("event-meta").locator("time").getAttribute("datetime"),
          "2030-01-10T16:30:00.000Z"
        );
        await page.getByRole("button", { name: "Back", exact: true }).click();
        const first = page.getByTestId("time").first();
        await first.focus();
        await first.press("Enter");
        await page.mouse.move(0, 0);
        await page.getByLabel("Your name*", { exact: true }).waitFor();
        assert.equal(
          await page.getByTestId("event-meta").locator("time").getAttribute("datetime"),
          "2030-01-10T09:00:00.000Z"
        );
        if (name === "desktop") {
          assert.ok(
            await page
              .getByRole("textbox", { name: "Your name", exact: true })
              .evaluate(
                (input) => document.activeElement === input && input.required && input.maxLength === 200
              )
          );
          assert.ok(
            await page
              .getByRole("textbox", { name: "Email address", exact: true })
              .evaluate((input) => input.required && input.maxLength === 254)
          );
          const region = await captureAttendeeRegion(page, artifacts, "candidate-desktop");
          assert.equal(
            await page.evaluate(differentPixels, [reference.attendeeRegion, region]),
            0,
            "Desktop month Email address through closed Add guests union pixels"
          );
          console.log(
            "PASS PARTIAL FORM-REGION parity: desktop month Email address through closed Add guests, 371x236, zero different RGBA pixels. Name remains focused and is outside the comparison."
          );
        }
        if (name === "mobile") {
          await verifyDialogComposition(page);
          const dialog = await verifyDialogTypography(page);
          assert.ok(
            dialog.font.equals(reference.dialog.font),
            "Public dialog served font matches actual Next"
          );
          assert.deepEqual(
            dialog.metrics,
            reference.dialog.metrics,
            "Public dialog typography matches actual Next"
          );
          const regions = await captureDialogRegions(page, artifacts, "candidate-mobile");
          for (const [part, region] of Object.entries(regions)) {
            assert.deepEqual(region.size, reference.dialogRegions[part].size, `${part} region size`);
            assert.deepEqual(region.styles, reference.dialogRegions[part].styles, `${part} region styles`);
            assert.equal(
              await page.evaluate(differentPixels, [reference.dialogRegions[part].pixels, region.pixels]),
              0,
              `Mobile dialog PARTIAL ${part} region RGBA`
            );
          }
          console.log(
            "PASS PARTIAL mobile dialog badge union, agreement and sticky footer regions have zero different RGBA pixels. Explicit timezone, whole header and whole dialog equality are excluded."
          );
          await page.getByRole("heading", { name: "Confirm your details", exact: true }).screenshot({
            path: fileURLToPath(new URL("candidate-mobile-heading.png", artifacts)),
          });
        }
        await page.screenshot({
          path: fileURLToPath(new URL(`candidate-page-${name}-form.png`, artifacts)),
          fullPage: true,
          animations: "disabled",
        });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    assert.equal(fixture.google.writes.length, 0);
  } finally {
    await fixture.close();
  }
  console.log(
    "PASS initial booking-card pixels match the actual pinned page at desktop/mobile, and the initial mobile full page matches with zero different pixels. Other full-page states remain unverified."
  );
}

export { verifyDefaultDialogs, verifyDialogTypography };
