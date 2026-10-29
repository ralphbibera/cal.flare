import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
        const href = await link.getAttribute("href");
        for (const privateValue of [
          receipt.access.token,
          created.email,
          created.name,
          "/booking/",
          "#token=",
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
      for (const privateValue of [receipt.access.token, created.email, created.name, "/booking/", "#token="])
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
        assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await verifyExports(target);
        await target.getByRole("button", { name: "Copy private booking link", exact: true }).focus();
        assert.ok(
          await target
            .getByRole("button", { name: "Copy private booking link", exact: true })
            .evaluate((node) => node === document.activeElement)
        );
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
    const choose = async () => {
      const previous = await currentTime();
      await page.getByRole("button", { name: "Reschedule", exact: true }).click();
      await hiddenExports();
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
        if (time !== previous) {
          await slots.nth(i).click();
          await hiddenExports();
          return time;
        }
      }
      await page.locator('[data-testid="day"]:not(:disabled)').last().click();
      await page.waitForFunction(
        (previous) => document.querySelector('[data-testid="time"]')?.getAttribute("data-time") !== previous,
        previous
      );
      const time = await slots.first().getAttribute("data-time");
      assert.ok(time && time !== previous);
      await slots.first().click();
      return time;
    };
    let selected = await choose();
    assert.ok(selected);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(requests.length, 0);
    selected = await choose();
    assert.ok(selected);
    for (const action of ["reschedule", "cancel"]) {
      const previousRequests = requests.length;
      if (action === "cancel") {
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await hiddenExports();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        assert.equal(requests.length, previousRequests);
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw new Error("Storage denied");
          };
        });
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
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
        .getByRole("button", { name: action === "cancel" ? "Confirm" : "Reschedule", exact: true })
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
        selected = await choose();
        assert.ok(selected);
        fixture.google.loseResponseAfter("update");
        await page.getByRole("button", { name: "Reschedule", exact: true }).click();
        await page
          .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
          .waitFor();
        await hiddenExports();
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
        assert.equal(fixture.google.writes.length, writes);
      }
    }
    await page.reload();
    await page.getByRole("heading", { name: "Canceled", exact: true }).waitFor();
    await hiddenExports();
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
