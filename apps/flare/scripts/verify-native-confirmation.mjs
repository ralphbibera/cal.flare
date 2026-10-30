import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const uid = "calflare-confirmation-reference-20300110";
const title = "Intro call between Organizer and Primary Attendee";
const hostEmail = "confirmation-organizer@reference.invalid";

async function readFixture() {
  const { stdout } = await promisify(execFile)("psql", [
    "postgresql://calflare_reference@127.0.0.1:18796/calflare_reference",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "BEGIN READ ONLY",
    "-c",
    `
      SELECT json_build_object(
        'counts', json_build_array(
          (SELECT count(*) FROM users), (SELECT count(*) FROM "EventType"),
          (SELECT count(*) FROM "Schedule"), (SELECT count(*) FROM "Attendee"),
          (SELECT count(*) FROM "Booking"), (SELECT count(*) FROM "Credential")),
        'mainBookings', (SELECT count(*) FROM "Booking" b JOIN users u ON u.id = b."userId" WHERE u.email = 'organizer@reference.invalid'),
        'booking', (SELECT to_jsonb(b) - 'oneTimePassword' FROM "Booking" b WHERE b.uid = '${uid}'),
        'host', (SELECT json_build_array(u.email, u.username, u.name, u."timeZone") FROM users u JOIN "Booking" b ON b."userId" = u.id WHERE b.uid = '${uid}'),
        'event', (SELECT json_build_array(e.slug, e.title, e.length, e.locations, e."userId", e."scheduleId") FROM "EventType" e JOIN "Booking" b ON b."eventTypeId" = e.id WHERE b.uid = '${uid}'),
        'attendees', (SELECT json_agg(a ORDER BY a.id) FROM "Attendee" a JOIN "Booking" b ON a."bookingId" = b.id WHERE b.uid = '${uid}')
      );`,
    "-c",
    "COMMIT",
  ]);
  const state = JSON.parse(stdout.split("\n").find((line) => line.startsWith("{")));
  assert.deepEqual(state.counts, [2, 2, 2, 1, 1, 0]);
  assert.equal(state.mainBookings, 0);
  assert.deepEqual(state.host, [hostEmail, "confirmation-reference", "Organizer", "UTC"]);
  assert.deepEqual(state.event.slice(0, 5), ["intro", "Intro call", 30, [], state.booking.userId]);
  assert.equal(state.booking.uid, uid);
  assert.equal(state.booking.title, title);
  assert.equal(state.booking.status, "accepted");
  assert.equal(state.booking.startTime, "2030-01-10T09:00:00");
  assert.equal(state.booking.endTime, "2030-01-10T09:30:00");
  assert.equal(state.booking.location, null);
  assert.equal(state.booking.recurringEventId, null);
  assert.equal(state.booking.description, "Synthetic confirmation fixture.");
  assert.equal(state.attendees.length, 1);
  assert.equal(state.attendees[0].bookingId, state.booking.id);
  assert.deepEqual(
    [state.attendees[0].name, state.attendees[0].email, state.attendees[0].timeZone],
    ["Primary Attendee", "primary@example.invalid", "UTC"]
  );
  return state;
}

async function readyConfirmation(page) {
  await page.locator("#modal-headline").waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.locator("img").count(),
    0,
    "This fixture has no images; public-page ready requires one"
  );
  await page.evaluate(async () => {
    let previous = "";
    let stable = 0;
    for (let frame = 0; frame < 900; frame++) {
      await new Promise(requestAnimationFrame);
      const nodes = [
        ...document.querySelectorAll('[data-testid="success-page"], [role="dialog"], [role="dialog"] *'),
      ];
      const signature = JSON.stringify(
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return [
            r.x,
            r.y,
            r.width,
            r.height,
            getComputedStyle(node).opacity,
            getComputedStyle(node).transform,
          ];
        })
      );
      const moving = document
        .getAnimations()
        .some((animation) => ["running", "pending"].includes(animation.playState));
      stable = !moving && signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable === 3) return;
    }
    throw new Error("Native confirmation geometry or animations did not settle");
  });
  assert.ok(
    await page.evaluate(() =>
      [...document.fonts].some((font) => font.family === "Inter" && font.status === "loaded")
    )
  );
}

export async function verifyNativeConfirmation(browser, origin, artifacts, differentPixels) {
  assert.equal(origin, "http://127.0.0.1:18800");
  const before = await readFixture();
  for (const [name, viewport] of [
    ["mobile", { width: 390, height: 844 }],
    ["desktop", { width: 1280, height: 900 }],
  ]) {
    const captures = [];
    const rows = [];
    for (const take of [1, 2]) {
      const context = await browser.newContext({
        viewport,
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
      });
      const errors = [];
      const requests = [];
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date("2030-01-09T12:00:00Z"));
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        page.on("response", (response) => {
          if (response.status() >= 400)
            errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
        });
        page.on("request", (request) => {
          const url = new URL(request.url());
          const query =
            url.pathname === "/api/trpc/features/map" && ["GET", "POST"].includes(request.method());
          const session = url.pathname === "/api/auth/session" && request.method() === "GET";
          if (
            url.origin !== origin ||
            !(query || session || (!url.pathname.startsWith("/api/") && request.method() === "GET"))
          ) {
            requests.push([request.method(), url.origin, url.pathname]);
          }
        });
        assert.equal((await page.goto(`${origin}/booking/${uid}`)).status(), 200);
        await page.mouse.move(0, 0);
        await readyConfirmation(page);
        const card = page.locator('[role="dialog"]');
        assert.equal(await page.locator("#modal-headline").innerText(), "This meeting is scheduled");
        assert.equal(await page.getByTestId("booking-title").innerText(), title);
        const exports = card.locator('a[href*="/calendar/"], a[download]');
        assert.deepEqual(await exports.allTextContents(), [
          "Google",
          "Microsoft Outlook",
          "Microsoft Office",
          "Other",
        ]);
        const row = card.getByText("Add to calendar", { exact: true }).locator("..");
        const geometry = await row.evaluate((node) => {
          const base = node.getBoundingClientRect();
          const rect = (element) => {
            const r = element.getBoundingClientRect();
            return [r.x - base.x, r.y - base.y, r.width, r.height];
          };
          const text = getComputedStyle(node.firstElementChild);
          const separator = getComputedStyle(node.previousElementSibling);
          return {
            row: [base.width, base.height],
            label: rect(node.firstElementChild),
            font: [text.fontSize, text.fontWeight, text.lineHeight, text.color],
            separator: [separator.marginTop, separator.borderTopWidth, separator.borderTopColor],
            links: [...node.querySelectorAll("a")].map((link) => {
              const style = getComputedStyle(link);
              return {
                box: rect(link),
                border: [style.borderTopWidth, style.borderTopColor, style.borderRadius],
                spacing: [style.marginLeft, style.marginRight, style.paddingTop, style.paddingRight],
                svg: rect(link.querySelector("svg")),
                viewBox: link.querySelector("svg").getAttribute("viewBox"),
              };
            }),
          };
        });
        const mobile = viewport.width === 390;
        assert.deepEqual(geometry.row, mobile ? [292, 80] : [510, 72]);
        assert.deepEqual(geometry.label, mobile ? [0, 32, 68, 48] : [82.40625, 40, 121.171875, 24]);
        assert.deepEqual(geometry.font, ["16px", "500", "24px", "rgb(60, 62, 68)"]);
        assert.deepEqual(geometry.separator, ["32px", "1px", "rgb(229, 231, 235)"]);
        for (const [index, link] of geometry.links.entries()) {
          const x = (mobile ? 76 : 211.578125) + index * 56;
          const y = mobile ? 36 : 32;
          assert.deepEqual(link.box, [x, y, 40, 40]);
          assert.deepEqual(link.border, ["1px", "rgb(229, 231, 235)", "6px"]);
          assert.deepEqual(link.spacing, [index === 0 ? "0px" : "8px", "8px", "8px", "12px"]);
          assert.deepEqual(link.svg, [x + 13, y + 11.625, 16, 16]);
          assert.equal(link.viewBox, index === 3 ? "0 0 1000 1000" : "0 0 24 24");
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        rows.push([
          ...(await row.screenshot({
            path: fileURLToPath(new URL(`upstream-confirmation-export-${name}-${take}.png`, artifacts)),
            animations: "disabled",
          })),
        ]);
        for (const [index, link] of (await exports.all()).entries()) {
          const box = await link.boundingBox();
          assert.equal(box.width, 40);
          assert.equal(box.height, 40);
          const href = await link.getAttribute("href");
          if (index === 3) {
            assert.equal(await link.getAttribute("download"), "Intro call.ics");
            assert.ok(href.startsWith("data:text/calendar,"));
            const ics = decodeURIComponent(href.slice(href.indexOf(",") + 1)).replace(/\r\n[ \t]/g, "");
            for (const line of [
              "VERSION:2.0",
              `SUMMARY:${title}`,
              "DTSTART:20300110T090000Z",
              "DURATION:PT30M",
              "DESCRIPTION:A short conversation.",
            ])
              assert.ok(ics.split("\r\n").includes(line));
          } else {
            assert.equal(await link.getAttribute("target"), "_blank");
            const url = new URL(href);
            assert.equal(
              url.hostname,
              ["calendar.google.com", "outlook.live.com", "outlook.office.com"][index]
            );
            assert.equal(url.searchParams.get(index === 0 ? "text" : "subject"), title);
            assert.equal(url.searchParams.get(index === 0 ? "details" : "body"), "A short conversation.");
            if (index === 0) assert.equal(url.searchParams.get("dates"), "20300110T090000Z/20300110T093000Z");
            else {
              assert.equal(url.searchParams.get("startdt"), "2030-01-10T09:00:00Z");
              assert.equal(url.searchParams.get("enddt"), "2030-01-10T09:30:00Z");
              assert.equal(decodeURIComponent(url.searchParams.get("path")), "/calendar/action/compose");
            }
          }
        }
        for (const label of ["What", "When", "Who", "Additional notes"]) {
          assert.equal(await card.getByText(label, { exact: true }).count(), 1);
        }
        assert.equal(
          await card.getByText("When", { exact: true }).evaluate((node) => node.nextElementSibling.innerText),
          "Thursday, January 10, 2030\n9:00 AM - 9:30 AM (Coordinated Universal Time)"
        );
        assert.equal(await page.getByTestId("booking-host-name").innerText(), "Organizer");
        assert.equal(await page.getByTestId("booking-host-email").innerText(), hostEmail);
        assert.equal(
          await page.getByTestId("attendee-name-Primary Attendee").innerText(),
          "Primary Attendee"
        );
        assert.equal(
          await page.getByTestId("attendee-email-primary@example.invalid").innerText(),
          "primary@example.invalid"
        );
        assert.equal(await card.getByText("Synthetic confirmation fixture.", { exact: true }).count(), 1);
        assert.equal(await page.getByTestId("where").count(), 0);
        assert.equal(
          await card
            .getByText("We sent an email with a calendar invitation with the details to everyone.", {
              exact: true,
            })
            .count(),
          1
        );
        assert.deepEqual(
          await card.locator('[data-testid="reschedule-link"], [data-testid="cancel"]').allTextContents(),
          ["Reschedule", "Cancel"]
        );
        assert.equal(await page.getByTestId("reschedule-link").getAttribute("href"), `/reschedule/${uid}`);
        const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
        assert.equal(schema.reservationId, uid);
        assert.equal(schema.reservationStatus, "ReservationConfirmed");
        assert.equal(schema.reservationFor.startDate, "2030-01-10T09:00:00.000Z");
        assert.equal(schema.reservationFor.endDate, "2030-01-10T09:30:00.000Z");
        captures.push([
          ...(await page.screenshot({
            path: fileURLToPath(new URL(`upstream-confirmation-${name}-${take}.png`, artifacts)),
            fullPage: true,
            animations: "disabled",
          })),
        ]);
        assert.deepEqual(errors, []);
        assert.deepEqual(
          requests,
          [],
          "Only local document/assets and source-backed session/feature queries are allowed"
        );
        assert.deepEqual(
          await readFixture(),
          before,
          "Read-only confirmation visit preserves fixture data and zero credentials"
        );
      } finally {
        await context.close();
      }
    }
    const comparison = await browser.newPage();
    try {
      assert.equal(
        await comparison.evaluate(differentPixels, captures),
        0,
        `${name} native whole-page confirmation repeat dimensions and every RGBA channel`
      );
      for (const [take, rowPixels] of rows.entries()) {
        for (const route of ["receipt", "private"]) {
          const candidate = await readFile(
            new URL(`confirmed-export-${route}-${viewport.width}.png`, artifacts)
          );
          assert.equal(
            await comparison.evaluate(differentPixels, [rowPixels, [...candidate]]),
            0,
            `${name} ${route} take ${take + 1} complete export row dimensions and every RGBA channel`
          );
        }
      }
      console.log(
        `PASS ${name} complete export row: both native takes, receipt and private have zero differing RGBA pixels.`
      );
    } finally {
      await comparison.close();
    }
    console.log(
      `PASS native /booking/${uid} ${viewport.width}px: two fresh whole-page takes repeat exactly; literal facts, no mutation requests, unchanged isolated booking and zero credentials. Email copy is UI content only.`
    );
  }
}
