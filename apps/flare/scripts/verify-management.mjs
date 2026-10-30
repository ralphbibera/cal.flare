import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cancellationReason = 'Plans changed\n\n<img src="/unexpected-reason" onerror="alert(1)"> é 😀\n'.padEnd(
  1000,
  "界"
);
const cancellationDraft = ` \n${cancellationReason}\t `;
const rescheduleReason = 'Schedule changed\n\n<img src="/unexpected-move" onerror="alert(1)"> é 😀\n'.padEnd(
  1000,
  "界"
);
const rescheduleDraft = ` \n${rescheduleReason}\t `;

async function verifyExportRow(page, width, name) {
  const row = page.getByText("Add to calendar", { exact: true }).locator("..");
  await row.screenshot({
    path: new URL(`../.verification/confirmed-export-${name}-${width}.png`, import.meta.url).pathname,
    animations: "disabled",
  });
  const metrics = await row.evaluate((node) => {
    const base = node.getBoundingClientRect();
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return [r.x - base.x, r.y - base.y, r.width, r.height];
    };
    const label = node.firstElementChild;
    const text = getComputedStyle(label);
    const separator = getComputedStyle(node.previousElementSibling);
    return {
      row: [base.width, base.height],
      label: rect(label),
      font: [text.fontSize, text.fontWeight, text.lineHeight, text.color],
      separator: [separator.marginTop, separator.borderTopWidth, separator.borderTopColor],
      links: [...node.querySelectorAll("a")].map((link) => {
        const style = getComputedStyle(link);
        const svg = link.querySelector("svg");
        return {
          box: rect(link),
          border: [style.borderTopWidth, style.borderTopColor, style.borderRadius],
          spacing: [style.marginLeft, style.marginRight, style.paddingTop, style.paddingRight],
          svg: rect(svg),
          viewBox: svg.getAttribute("viewBox"),
          decorative: svg.getAttribute("aria-hidden"),
        };
      }),
    };
  });
  const mobile = width === 390;
  assert.deepEqual(metrics.row, mobile ? [292, 80] : [510, 72], "Complete native export-row bounds");
  assert.deepEqual(metrics.label, mobile ? [0, 32, 68, 48] : [82.40625, 40, 121.171875, 24]);
  assert.deepEqual(metrics.font, ["16px", "500", "24px", "rgb(60, 62, 68)"]);
  assert.deepEqual(metrics.separator, ["32px", "1px", "rgb(229, 231, 235)"]);
  assert.equal(metrics.links.length, 4);
  for (const [index, link] of metrics.links.entries()) {
    const x = (mobile ? 76 : 211.578125) + index * 56;
    const y = mobile ? 36 : 32;
    assert.deepEqual(link.box, [x, y, 40, 40]);
    assert.deepEqual(link.border, ["1px", "rgb(229, 231, 235)", "6px"]);
    assert.deepEqual(link.spacing, [index === 0 ? "0px" : "8px", "8px", "8px", "12px"]);
    assert.deepEqual(link.svg, [x + 13, y + 11.625, 16, 16]);
    assert.equal(link.viewBox, index === 3 ? "0 0 1000 1000" : "0 0 24 24");
    assert.equal(link.decorative, "true");
  }
}

async function verifyPresentation(page, width) {
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.locator("section:has(> dl)").evaluate((card) => {
    const rect = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const style = getComputedStyle(card);
    const heading = card.querySelector("h1");
    const details = card.querySelector("dl");
    const check = card.querySelector("svg");
    const pixel = document.createElement("canvas").getContext("2d");
    pixel.fillStyle = getComputedStyle(check).color;
    pixel.fillRect(0, 0, 1, 1);
    const font = (node) => {
      const s = getComputedStyle(node);
      return [s.fontFamily.split(",")[0], s.fontSize, s.fontWeight, s.lineHeight];
    };
    return {
      card: rect(card),
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      border: [style.borderTopWidth, style.borderRadius, style.borderTopColor],
      heading: font(heading),
      details: rect(details),
      label: font(details.querySelector("dt")),
      value: font(details.querySelector("dd")),
      valueX: details.querySelector("dd").getBoundingClientRect().x,
      gap: getComputedStyle(details).columnGap,
      emblem: rect(check.parentElement),
      emblemColor: getComputedStyle(check.parentElement).backgroundColor,
      check: [rect(check).width, rect(check).height, [...pixel.getImageData(0, 0, 1, 1).data]],
      path: check.querySelector("path")?.getAttribute("d"),
      stroke: [
        check.getAttribute("stroke-width"),
        check.getAttribute("stroke-linecap"),
        check.getAttribute("stroke-linejoin"),
      ],
      decorative: check.getAttribute("aria-hidden"),
      background: getComputedStyle(document.body).backgroundColor,
      loaded: [...document.fonts].some(
        (face) => face.family.replaceAll('"', "") === "Inter Booking" && face.status === "loaded"
      ),
      fontSource: [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .find((rule) => rule.type === CSSRule.FONT_FACE_RULE && rule.style.fontFamily === '"Inter Booking"')
        ?.style.src,
    };
  });
  const mobile = width === 390;
  assert.deepEqual(
    [metrics.card.x, metrics.card.y, metrics.card.width],
    mobile ? [16, 32, 358] : [352, 32, 576],
    "Native confirmation frame contract, without a fixed height"
  );
  assert.deepEqual(metrics.padding, mobile ? ["20px", "32px", "16px", "32px"] : Array(4).fill("32px"));
  assert.deepEqual(metrics.border, ["1px", "10px", "rgb(229, 231, 235)"]);
  assert.deepEqual(metrics.heading, ['"Inter Booking"', "24px", "600", "24px"]);
  assert.deepEqual(metrics.label, ['"Inter Booking"', "16px", "500", "24px"]);
  assert.deepEqual(metrics.value, ['"Inter Booking"', "16px", "400", "24px"]);
  assert.deepEqual([metrics.details.x, metrics.details.width], mobile ? [49, 292] : [385, 510]);
  assert.equal(metrics.gap, mobile ? "16px" : "0px");
  if (!mobile) assert.equal(metrics.valueX, 555);
  assert.deepEqual([metrics.emblem.width, metrics.emblem.height], [48, 48]);
  assert.equal(metrics.emblem.y, mobile ? 53 : 65);
  assert.equal(metrics.emblemColor, "rgb(228, 251, 237)");
  assert.deepEqual(metrics.check, [20, 20, [0, 166, 62, 255]]);
  assert.equal(metrics.path, "M20 6 9 17l-5-5");
  assert.deepEqual(metrics.stroke, ["2", "round", "round"]);
  assert.equal(metrics.decorative, "true");
  assert.equal(metrics.background, "rgb(238, 239, 242)");
  assert.ok(metrics.loaded, "Pinned Inter Booking face is loaded for confirmation text and heading");
  assert.match(metrics.fontSource, /url\("\/fonts\/Inter-booking-latin\.woff2"\)/);
  const font = await page.request.get(new URL("/fonts/Inter-booking-latin.woff2", page.url()).href);
  assert.equal(font.status(), 200);
  assert.ok(
    (await font.body()).equals(
      await readFile(new URL("../public/fonts/Inter-booking-latin.woff2", import.meta.url))
    )
  );
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

export async function verifyManagement(browser, fixture, date) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
  const errors = [],
    requests = [],
    bookingPosts = [];
  context.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/bookings") && request.method() === "POST")
      bookingPosts.push(request.url());
  });
  try {
    const page = await context.newPage();
    await page.clock.install({ time: date });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${fixture.origin}/${fixture.settings.event.slug}`);
    await page.getByTestId("time").first().click();
    await page.getByLabel("Your name*", { exact: true }).fill("Management Guest");
    await page.getByLabel("Email address*", { exact: true }).fill("management@example.test");
    const before = fixture.google.writes.length;
    const creation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/bookings" && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    const created = await (await creation).json();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(await page.locator("textarea").count(), 0);
    assert.equal(await page.getByText("Add to calendar", { exact: true }).count(), 1);
    const canonicalDetails = async (target) => {
      assert.deepEqual(
        await target.locator("dl time").evaluateAll((nodes) => nodes.map((node) => node.dateTime)),
        [new Date(created.start).toISOString(), new Date(created.end).toISOString()]
      );
      for (const label of ["What", "When", "Who"])
        assert.equal(await target.locator("dt").getByText(label, { exact: true }).count(), 1);
      for (const value of [created.title, created.name, created.email, created.timeZone, "30m"])
        assert.equal(await target.locator("dd").getByText(value, { exact: true }).count(), 1);
      assert.equal(created.end - created.start, 30 * 60_000);
      assert.equal(await target.getByTestId("event-meta").count(), 0);
      assert.equal(
        await target.locator("dd").nth(1).locator("p").first().textContent(),
        new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: created.timeZone }).formatRange(
          created.start,
          created.end
        )
      );
    };
    await canonicalDetails(page);
    const receipt = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem(`calflare:create:v1:${encodeURIComponent(location.pathname)}`))
    );
    const hiddenExports = async () =>
      assert.equal(await page.getByText("Add to calendar", { exact: true }).count(), 0);
    const verifyExports = async (target, booking = created) => {
      await target.getByText("Add to calendar", { exact: true }).waitFor();
      const names = ["Google", "Microsoft Outlook", "Microsoft Office", "Other"];
      const links = target.locator("a[aria-label]");
      assert.deepEqual(
        await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
        names
      );
      const compact = (value) => new Date(value).toISOString().replace(/[-:]|\.\d{3}/g, "");
      for (const [index, name] of names.entries()) {
        const link = target.getByRole("link", { name, exact: true });
        if (index === 0) await link.focus();
        else await target.keyboard.press("Tab");
        assert.ok(await link.evaluate((node) => node === document.activeElement));
        if (index > 0)
          assert.deepEqual(
            await link.evaluate((node) => {
              const style = getComputedStyle(node);
              return [style.outlineWidth, style.outlineOffset, style.outlineStyle];
            }),
            ["2px", "2px", "solid"]
          );
        const href = await link.getAttribute("href");
        for (const privateValue of [
          receipt.access.token,
          created.email,
          created.name,
          "/booking/",
          "#token=",
          rescheduleReason,
        ])
          assert.ok(!decodeURIComponent(href).includes(privateValue));
        if (index === 3) continue;
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
        const url = new URL(href);
        assert.equal(
          url.origin + url.pathname,
          [
            "https://calendar.google.com/calendar/r/eventedit",
            "https://outlook.live.com/calendar/0/deeplink/compose",
            "https://outlook.office.com/calendar/0/deeplink/compose",
          ][index]
        );
        assert.deepEqual(
          Object.fromEntries(url.searchParams),
          index === 0
            ? {
                dates: `${compact(booking.start)}/${compact(booking.end)}`,
                text: booking.title,
              }
            : {
                path: "/calendar/action/compose",
                rru: "addevent",
                startdt: new Date(booking.start).toISOString(),
                enddt: new Date(booking.end).toISOString(),
                subject: booking.title,
              }
        );
      }
      const writes = fixture.google.writes.length,
        mutations = bookingPosts.length;
      const downloadEvent = target.waitForEvent("download");
      await target.keyboard.press("Enter");
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), "booking.ics");
      const bytes = await readFile(await download.path());
      const ics = bytes.toString("utf8");
      assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
      assert.ok(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n"));
      for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
      const unfolded = ics.replace(/\r\n /g, "");
      for (const line of [
        `UID:${booking.id}@calflare.invalid`,
        `SEQUENCE:${booking.version}`,
        `SUMMARY:${booking.title}`,
        `DTSTART:${compact(booking.start)}`,
        `DTEND:${compact(booking.end)}`,
      ])
        assert.ok(unfolded.split("\r\n").includes(line));
      assert.doesNotMatch(unfolded, /\r\n(?:METHOD|ATTENDEE|ORGANIZER|DESCRIPTION|LOCATION|URL):/);
      for (const privateValue of [
        receipt.access.token,
        created.email,
        created.name,
        "/booking/",
        "#token=",
        rescheduleReason,
      ])
        assert.ok(!unfolded.includes(privateValue));
      assert.equal(bookingPosts.length, mutations);
      assert.equal(fixture.google.writes.length, writes);
    };
    await verifyExports(page);
    const composer = /https:\/\/(?:calendar\.google\.com|outlook\.(?:live|office)\.com)\//;
    await context.route(composer, (route) => route.abort());
    const popup = context.waitForEvent("page"),
      navigation = context.waitForEvent("request", { predicate: (request) => composer.test(request.url()) });
    const googleLink = page.getByRole("link", { name: "Google", exact: true });
    const expectedComposer = await googleLink.getAttribute("href");
    await googleLink.focus();
    await page.keyboard.press("Enter");
    assert.equal((await navigation).url(), expectedComposer);
    await (await popup).close();
    const path = `/api/bookings/${receipt.access.id}`;
    const snapshot = () =>
      fixture.db
        .prepare("SELECT confirmed_json FROM booking WHERE id=?")
        .bind(receipt.access.id)
        .first("confirmed_json");
    const immutable = await snapshot();
    const storedBooking = JSON.parse(immutable);
    for (const key of ["title", "start", "end", "timeZone"]) assert.equal(created[key], storedBooking[key]);
    const saved = () =>
      page.evaluate(
        (id) => JSON.parse(sessionStorage.getItem(`calflare:change:v1:${id}`)),
        receipt.access.id
      );
    const currentTime = () => page.locator("dl time").first().getAttribute("datetime");
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === path && request.method() === "POST") {
        requests.push(request.postDataJSON());
        if (request.headers().authorization !== `Bearer ${receipt.access.token}`)
          errors.push("Missing management authorization");
      }
    });
    const owner = await fixture.login();
    const original = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    const configure = async (disableCancelling, disableRescheduling) => {
      await fixture.read(
        await fixture.send(
          "/api/owner",
          {
            ...original,
            event: {
              ...original.event,
              title: "Changed after booking",
              durationMinutes: 90,
              disableCancelling,
              disableRescheduling,
            },
          },
          owner,
          "PUT"
        )
      );
    };
    const privatePage = await context.newPage();
    await privatePage.clock.install({ time: date });
    privatePage.on("pageerror", (error) => errors.push(error.message));
    privatePage.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    privatePage.on("request", (request) => {
      if (new URL(request.url()).pathname === path && request.method() === "POST")
        errors.push("Loading policy controls must not mutate the booking");
    });
    const policyWrites = fixture.google.writes.length;
    for (const [disableCancelling, disableRescheduling] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      await configure(disableCancelling, disableRescheduling);
      await page.reload();
      if (privatePage.url() === "about:blank")
        await privatePage.goto(
          `${fixture.origin}/booking/${receipt.access.id}#token=${receipt.access.token}`
        );
      else await privatePage.reload();
      for (const target of [page, privatePage]) {
        await target.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
        await target.getByRole("button", { name: "Check booking status", exact: true }).waitFor();
        await canonicalDetails(target);
        await verifyExports(target);
        assert.equal(await target.getByText("Changed after booking", { exact: true }).count(), 0);
        assert.equal(
          await target.getByRole("button", { name: "Reschedule", exact: true }).count(),
          disableRescheduling ? 0 : 1
        );
        assert.equal(
          await target.getByRole("button", { name: "Cancel event", exact: true }).count(),
          disableCancelling ? 0 : 1
        );
        assert.equal(
          await target.getByRole("button", { name: "Copy private booking link", exact: true }).count(),
          1
        );
        assert.ok(!(await target.content()).includes(receipt.access.token));
      }
      assert.equal(privatePage.url(), `${fixture.origin}/booking/${receipt.access.id}`);
      assert.equal(requests.length, 0);
      assert.equal(fixture.google.writes.length, policyWrites);
      assert.equal(await snapshot(), immutable);
    }
    for (const width of [390, 1280]) {
      for (const [name, target] of [
        ["receipt", page],
        ["private", privatePage],
      ]) {
        await target.setViewportSize({ width, height: 900 });
        await verifyPresentation(target, width);
        assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await verifyExports(target);
        await target.getByRole("button", { name: "Copy private booking link", exact: true }).focus();
        assert.ok(
          await target
            .getByRole("button", { name: "Copy private booking link", exact: true })
            .evaluate((node) => node === document.activeElement)
        );
        await verifyExportRow(target, width, name);
        await target.screenshot({
          path: new URL(`../.verification/confirmed-${name}-${width}.png`, import.meta.url).pathname,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await privatePage.setViewportSize({ width: 390, height: 844 });
    await privatePage.screenshot({
      path: new URL("../.verification/management-policy-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await configure(false, false);
    await page.getByRole("button", { name: "Check booking status", exact: true }).click();
    await page.getByRole("button", { name: "Reschedule", exact: true }).waitFor();
    await page.getByRole("button", { name: "Cancel event", exact: true }).waitFor();
    await fixture.read(await fixture.send("/api/owner", original, owner, "PUT"));
    await privatePage.close();
    const choose = async (excluded) => {
      const previous = await currentTime();
      await page.getByRole("button", { name: "Reschedule", exact: true }).click();
      await hiddenExports();
      assert.equal(await page.locator("textarea").count(), 0);
      assert.equal(await page.locator("dt").getByText("Reschedule reason", { exact: true }).count(), 0);
      const slots = page.getByTestId("time");
      await slots.first().waitFor();
      for (const width of [390, 768, 1024, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: new URL("../.verification/management-calendar-mobile.png", import.meta.url).pathname,
        fullPage: true,
        animations: "disabled",
      });
      for (let i = 0; i < (await slots.count()); i++) {
        const time = await slots.nth(i).getAttribute("data-time");
        if (time !== previous && time !== excluded) {
          await slots.nth(i).click();
          await hiddenExports();
          return time;
        }
      }
      const days = page.locator('[data-testid="day"]:not(:disabled)');
      if (excluded) await days.nth((await days.count()) - 2).click();
      else await days.last().click();
      await page.waitForFunction(
        ({ previous, excluded }) => {
          const time = document.querySelector('[data-testid="time"]')?.getAttribute("data-time");
          return time && time !== previous && time !== excluded;
        },
        { previous, excluded }
      );
      const time = await slots.first().getAttribute("data-time");
      assert.ok(time && time !== previous && time !== excluded);
      await slots.first().click();
      return time;
    };
    let selected = await choose();
    assert.ok(selected);
    const moveEditor = page.getByRole("textbox", { name: "Reason for reschedule", exact: true });
    await moveEditor.waitFor({ timeout: 3000 });
    assert.equal(await moveEditor.inputValue(), "");
    assert.equal(await moveEditor.getAttribute("rows"), "3");
    assert.equal(await moveEditor.getAttribute("placeholder"), "Let others know why you need to reschedule");
    assert.equal(await moveEditor.getAttribute("maxlength"), null);
    assert.equal(await moveEditor.getAttribute("required"), null);
    await moveEditor.fill("Draft é 😀");
    await moveEditor.press("End");
    await moveEditor.press("Enter");
    assert.equal(await moveEditor.inputValue(), "Draft é 😀\n");
    assert.ok(await moveEditor.evaluate((node) => node === document.activeElement));
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await page.locator("textarea").count(), 0);
    assert.equal(requests.length, 0);
    const firstSelection = selected;
    selected = await choose(firstSelection);
    assert.ok(selected);
    assert.notEqual(selected, firstSelection);
    assert.equal(await moveEditor.inputValue(), "Draft é 😀\n");
    assert.equal(await page.locator("section > time").getAttribute("datetime"), selected);
    await page.evaluate(() => {
      window.changeStorageWrites = 0;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("calflare:change:v1:")) window.changeStorageWrites++;
        return setItem.call(this, key, value);
      };
    });
    const unchangedStorage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
    const unchangedWrites = fixture.google.writes.length;
    const invalidMove = ` \n${"😀".repeat(500)}x\t `;
    await moveEditor.fill(invalidMove);
    await page.getByRole("button", { name: "Reschedule", exact: true }).click();
    const moveError = page.getByRole("alert").filter({ hasText: "Must be 1000 or fewer characters long" });
    await moveError.waitFor();
    assert.equal(await moveEditor.getAttribute("aria-invalid"), "true");
    assert.equal(await moveEditor.getAttribute("aria-describedby"), await moveError.getAttribute("id"));
    assert.equal(await moveEditor.inputValue(), invalidMove);
    assert.ok(await moveEditor.isEditable());
    assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage })), unchangedStorage);
    assert.equal(await page.evaluate(() => window.changeStorageWrites), 0);
    assert.equal(requests.length, 0);
    assert.equal(fixture.google.writes.length, unchangedWrites);
    await moveEditor.fill(rescheduleDraft);
    assert.equal(await moveEditor.getAttribute("aria-invalid"), "false");
    assert.equal(await moveError.count(), 0);
    assert.equal(await page.locator("section > time").getAttribute("datetime"), selected);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: new URL(`../.verification/reschedule-intent-${width}.png`, import.meta.url).pathname,
        fullPage: true,
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const action of ["reschedule", "cancel"]) {
      const previousRequests = requests.length;
      if (action === "cancel") {
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await hiddenExports();
        const editor = page.getByRole("textbox", { name: "Reason for cancellation (optional)", exact: true });
        await editor.waitFor();
        assert.equal(await page.locator("textarea").count(), 1);
        assert.equal(await editor.getAttribute("rows"), "3");
        assert.equal(await editor.getAttribute("placeholder"), "Why are you cancelling?");
        assert.equal(await editor.getAttribute("maxlength"), null);
        assert.equal(await editor.getAttribute("required"), null);
        await editor.fill("Draft é 😀");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        assert.equal(await editor.inputValue(), "Draft é 😀\n");
        assert.ok(await editor.evaluate((node) => node === document.activeElement));
        await page.evaluate(() => {
          window.changeStorageWrites = 0;
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("calflare:change:v1:")) window.changeStorageWrites++;
            return setItem.call(this, key, value);
          };
        });
        const unchangedStorage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
        const unchangedWrites = fixture.google.writes.length;
        await page.keyboard.press("Tab");
        assert.ok(
          await page
            .getByRole("button", { name: "Nevermind", exact: true })
            .evaluate((node) => node === document.activeElement)
        );
        await page.keyboard.press("Enter");
        await page.getByText("Add to calendar", { exact: true }).waitFor();
        assert.equal(await page.locator("textarea").count(), 0);
        assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage })), unchangedStorage);
        assert.equal(requests.length, previousRequests);
        assert.equal(fixture.google.writes.length, unchangedWrites);
        assert.equal(await page.evaluate(() => window.changeStorageWrites), 0);
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        assert.equal(await editor.inputValue(), "Draft é 😀\n");
        const invalid = " \n" + "😀".repeat(500) + "x\t ";
        await editor.fill(invalid);
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "Must be 1000 or fewer characters long" }).waitFor();
        assert.equal(await editor.getAttribute("aria-invalid"), "true");
        assert.equal(
          await editor.getAttribute("aria-describedby"),
          await page.getByRole("alert").getAttribute("id")
        );
        assert.equal(await editor.inputValue(), invalid);
        assert.ok(await editor.isEditable());
        assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage })), unchangedStorage);
        assert.equal(requests.length, previousRequests);
        assert.equal(fixture.google.writes.length, unchangedWrites);
        assert.equal(await page.evaluate(() => window.changeStorageWrites), 0);
        await editor.fill(" \n" + "😀".repeat(500) + "\t ");
        assert.equal(await editor.getAttribute("aria-invalid"), "false");
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw new Error("Storage denied");
          };
        });
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "We couldn't restore or save this booking safely" })
          .waitFor();
        assert.equal(
          await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
          0
        );
        assert.equal(requests.length, previousRequests);
        await hiddenExports();
        await page.reload();
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await editor.fill(cancellationDraft);
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({
            path: new URL(`../.verification/cancellation-intent-${width}.png`, import.meta.url).pathname,
            fullPage: true,
            animations: "disabled",
          });
        }
        await page.setViewportSize({ width: 390, height: 844 });
      }
      const applied = Promise.withResolvers();
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        try {
          const response = await route.fetch();
          applied.resolve({ status: response.status(), booking: await response.json() });
          await route.fulfill({ status: 200, contentType: "application/json", body: "truncated" });
        } catch (error) {
          applied.reject(error);
        }
      });
      await page
        .getByRole("button", { name: action === "cancel" ? "Cancel event" : "Reschedule", exact: true })
        .click();
      const result = await applied.promise;
      assert.equal(result.status, 200);
      assert.equal(result.booking.status, action === "cancel" ? "cancelled" : "confirmed");
      assert.equal(result.booking.start, Date.parse(selected));
      await page.getByRole("alert").waitFor();
      await hiddenExports();
      const pending = await saved(),
        writes = fixture.google.writes.length;
      assert.equal(pending.action, action);
      assert.deepEqual(pending, requests.at(-1));
      if (action === "reschedule") {
        assert.equal(pending.rescheduleReason, rescheduleReason);
        assert.equal(await moveEditor.inputValue(), rescheduleReason);
        assert.equal(await moveEditor.getAttribute("readonly"), "");
        assert.equal(await page.locator("section > time").getAttribute("datetime"), selected);
        assert.equal(await page.locator("dt").getByText("Reschedule reason", { exact: true }).count(), 0);
      }
      if (action === "cancel") {
        assert.equal(pending.cancellationReason, cancellationReason);
        const editor = page.getByRole("textbox", { name: "Reason for cancellation (optional)", exact: true });
        assert.equal(await editor.inputValue(), cancellationReason);
        assert.equal(await editor.getAttribute("readonly"), "");
        assert.equal(await page.locator("dt").getByText("Reason", { exact: true }).count(), 0);
      }
      assert.equal(await page.getByRole("button", { name: "Back", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
        0
      );
      await page.addInitScript((id) => {
        window.confirmedWhileUnresolved = false;
        new MutationObserver(() => {
          if (
            sessionStorage.getItem(`calflare:change:v1:${id}`) &&
            ([...document.querySelectorAll("h1, h2")].some(
              (heading) => heading.textContent === "This meeting is scheduled"
            ) ||
              !!document.querySelector('a[aria-label="Google"]'))
          )
            window.confirmedWhileUnresolved = true;
        }).observe(document, { subtree: true, childList: true, characterData: true });
      }, receipt.access.id);
      await configure(true, true);
      await page.reload();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      await hiddenExports();
      assert.equal(
        await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
        0
      );
      assert.deepEqual(await saved(), pending);
      if (action === "reschedule") {
        assert.equal(await moveEditor.inputValue(), rescheduleReason);
        assert.equal(await moveEditor.getAttribute("readonly"), "");
        assert.equal(await page.locator("section > time").getAttribute("datetime"), selected);
        assert.equal(await page.getByRole("button", { name: "Reschedule", exact: true }).count(), 0);
        assert.equal(await page.locator("dt").getByText("Reschedule reason", { exact: true }).count(), 0);
        await page.screenshot({
          path: new URL("../.verification/reschedule-pending-390.png", import.meta.url).pathname,
          fullPage: true,
          animations: "disabled",
        });
      }
      if (action === "cancel") {
        const editor = page.getByRole("textbox", { name: "Reason for cancellation (optional)", exact: true });
        assert.equal(await editor.inputValue(), cancellationReason);
        assert.equal(await editor.getAttribute("readonly"), "");
        assert.equal(await page.locator("dt").getByText("Reason", { exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Nevermind", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Reschedule", exact: true }).count(), 0);
      }
      assert.equal(await page.evaluate(() => window.confirmedWhileUnresolved), false);
      assert.equal(fixture.google.writes.length, writes);
      assert.equal(requests.length, previousRequests + 1);
      await page.unroute(`**${path}`);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page
        .getByRole("heading", {
          name: action === "cancel" ? "Canceled" : "This meeting is scheduled",
          exact: true,
        })
        .waitFor();
      assert.deepEqual(requests.at(-1), requests.at(-2));
      assert.equal(await saved(), null);
      if (action === "reschedule") await verifyExports(page, result.booking);
      else await hiddenExports();
      assert.equal(await currentTime(), selected);
      assert.equal(fixture.google.writes.length, writes);
      assert.ok(!(await page.content()).includes(receipt.access.token));
      assert.ok(!page.url().includes(receipt.access.token));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: new URL(`../.verification/management-${action}-mobile.png`, import.meta.url).pathname,
        fullPage: true,
        animations: "disabled",
      });
      await fixture.read(await fixture.send("/api/owner", original, owner, "PUT"));
      if (action === "reschedule") {
        assert.equal(await page.getByRole("button", { name: "Reschedule", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
        await page.getByRole("button", { name: "Check booking status", exact: true }).click();
        await page.getByRole("button", { name: "Reschedule", exact: true }).waitFor();
        await choose();
        assert.equal(await moveEditor.inputValue(), "");
        await page.getByRole("button", { name: "Back", exact: true }).click();
        const privateMoved = await context.newPage();
        try {
          await privateMoved.clock.install({ time: date });
          await privateMoved.goto(
            `${fixture.origin}/booking/${receipt.access.id}#token=${receipt.access.token}`
          );
          for (const width of [390, 1280]) {
            for (const target of [page, privateMoved]) {
              await target.setViewportSize({ width, height: 900 });
              await target.reload();
              await target.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
              await target.getByRole("button", { name: "Check booking status", exact: true }).waitFor();
              const reason = target.locator("dt").getByText("Reschedule reason", { exact: true });
              const value = reason.locator("xpath=following-sibling::dd[1]");
              assert.equal(await reason.count(), 1);
              assert.equal(await value.textContent(), rescheduleReason);
              assert.equal(await value.evaluate((node) => getComputedStyle(node).whiteSpace), "pre-wrap");
              assert.equal(await target.locator("dl img, dl script, textarea").count(), 0);
              assert.equal(await target.locator("dl time").first().getAttribute("datetime"), selected);
              assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
              assert.ok(!decodeURIComponent(target.url()).includes(rescheduleReason));
              assert.ok(!(await target.content()).includes(receipt.access.token));
              await verifyExports(target, result.booking);
            }
            await privateMoved.screenshot({
              path: new URL(`../.verification/reschedule-reason-${width}.png`, import.meta.url).pathname,
              fullPage: true,
              animations: "disabled",
            });
          }
        } finally {
          await privateMoved.close();
        }
        await page.setViewportSize({ width: 390, height: 844 });
        selected = await choose();
        assert.ok(selected);
        assert.equal(await moveEditor.inputValue(), "");
        assert.equal(await page.locator("dt").getByText("Reschedule reason", { exact: true }).count(), 0);
        fixture.google.loseResponseAfter("update");
        await page.getByRole("button", { name: "Reschedule", exact: true }).click();
        await page
          .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
          .waitFor();
        await hiddenExports();
        assert.ok(!Object.hasOwn(requests.at(-1), "rescheduleReason"));
        assert.equal(await page.locator("dt").getByText("Reschedule reason", { exact: true }).count(), 0);
        const writes = fixture.google.writes.length;
        assert.equal(await saved(), null);
        assert.equal(
          await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
          0
        );
        assert.equal(await page.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
        await page.reload();
        await page
          .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Check booking status", exact: true }).click();
        await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
        assert.equal(await currentTime(), selected);
        assert.equal(await page.locator("dt").getByText("Reschedule reason", { exact: true }).count(), 0);
        assert.equal(fixture.google.writes.length, writes);
      }
    }
    await page.reload();
    await page.getByRole("heading", { name: "Canceled", exact: true }).waitFor();
    await hiddenExports();
    const cancelledContext = await browser.newContext({ timezoneId: "UTC" });
    try {
      const privateCancelled = await cancelledContext.newPage();
      await privateCancelled.clock.install({ time: date });
      privateCancelled.on("pageerror", (error) => errors.push(error.message));
      privateCancelled.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await privateCancelled.goto(
        `${fixture.origin}/booking/${receipt.access.id}#token=${receipt.access.token}`
      );
      for (const width of [390, 1280]) {
        for (const target of [page, privateCancelled]) {
          await target.setViewportSize({ width, height: 900 });
          await target.reload();
          await target.getByRole("heading", { name: "Canceled", exact: true }).waitFor();
          await target.getByRole("button", { name: "Check booking status", exact: true }).waitFor();
          const reason = target.locator("dt").getByText("Reason", { exact: true });
          assert.equal(await target.locator("dt").getByText("Reschedule reason", { exact: true }).count(), 0);
          assert.equal(await reason.count(), 1);
          const value = reason.locator("xpath=following-sibling::dd[1]");
          assert.equal(await value.textContent(), cancellationReason);
          assert.equal(await value.evaluate((node) => getComputedStyle(node).whiteSpace), "pre-wrap");
          assert.equal(await target.locator("dl img, dl script").count(), 0);
          assert.equal(await target.locator("textarea").count(), 0);
          assert.equal(await target.getByRole("button", { name: "Reschedule", exact: true }).count(), 0);
          assert.equal(await target.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
          assert.equal(await target.getByText("Add to calendar", { exact: true }).count(), 0);
          assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          assert.ok(!decodeURIComponent(target.url()).includes(cancellationReason));
          assert.ok(!(await target.content()).includes(receipt.access.token));
        }
        await privateCancelled.screenshot({
          path: new URL(`../.verification/cancellation-reason-${width}.png`, import.meta.url).pathname,
          fullPage: true,
          animations: "disabled",
        });
      }
    } finally {
      await cancelledContext.close();
    }
    assert.equal(await page.getByRole("button", { name: "Reschedule", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
    assert.deepEqual(
      fixture.google.writes.slice(before).map((write) => write.action),
      ["insert", "update", "update", "delete"]
    );
    assert.equal(bookingPosts.filter((url) => new URL(url).pathname === "/api/bookings").length, 1);
    assert.equal(bookingPosts.filter((url) => new URL(url).pathname === `${path}/retry`).length, 1);
    assert.equal(bookingPosts.length, requests.length + 2);
    assert.equal(
      await fixture.db
        .prepare("SELECT count(*) FROM booking_command WHERE booking_id=?")
        .bind(receipt.access.id)
        .first("count(*)"),
      4
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    console.log(
      "PASS canonical receipt/private facts, keyboard composer links and actual ICS downloads survive event changes and rescheduling; exports hide during uncertain/change/cancelled stages. Aborted composer popup, privacy and exact replay without duplicate Calendar writes verified. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}
