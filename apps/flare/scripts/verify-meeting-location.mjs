import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";

export async function verifyMeetingLocationPrivacy(fixture) {
  const owner = await fixture.login();
  const marker = "private-location-ssr-marker";
  const location = `${marker}\r\n東京 😀 <img src="/private-location-probe" onerror="alert(1)">`;
  const settings = { ...fixture.settings, event: { ...fixture.settings.event, location } };
  const slots = `/api/slots?${new URLSearchParams({
    from: new Date(Date.now() + 86_400_000).toISOString(),
    to: new Date(Date.now() + 172_800_000).toISOString(),
    timeZone: "UTC",
  })}`;
  assert.equal((await fixture.send("/api/owner", settings, owner, "PUT")).status, 200);
  const authorized = await fixture.read(await fixture.request("/api/owner", { headers: owner }));
  assert.ok(authorized.settings.event.location === location);
  for (const [path, status] of [
    ["/api/public", 200],
    [`/${settings.event.slug}`, 200],
    ["/missing-event", 404],
    [slots, 200],
    ["/api/slots?timeZone=invalid", 400],
    ["/api/owner", 401],
    ["/api/owner/bookings/missing", 401],
    ["/", 200],
    ["/owner/bookings", 200],
    ["/owner/bookings/missing", 200],
  ]) {
    const response = await fixture.request(path);
    assert.equal(response.status, status, path);
    const text = await response.text();
    assert.equal(text.includes(marker), false, `location redacted from ${path}`);
    assert.equal(text.includes("private-location-probe"), false);
    if (path === `/${settings.event.slug}`) assert.ok(text.includes("<astro-island"));
    if (path === "/api/public") assert.equal(Object.hasOwn(JSON.parse(text).event, "location"), false);
  }
  assert.equal(fixture.google.writes.length, 0);
  assert.deepEqual(fixture.upstreamFailures, []);
  console.log(
    "PASS private location owner API and public JSON/SSR/hydration redaction. Built Worker/local D1; Google is mocked."
  );
}

export async function verifyMeetingLocationFlow(browser, fixture, date) {
  const owner = await fixture.login(),
    contexts = [],
    errors = [],
    posts = [],
    saves = [];
  const location = `Room-private-marker &location=evil, Floor;2\\\n東京 😀 <img src="/private-location-probe" onerror="alert(1)">\n${"x".repeat(180)}`;
  const initialWrites = fixture.google.writes.length;
  const open = async (authenticated = false) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
    contexts.push(context);
    if (authenticated)
      await context.addCookies([
        { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
      ]);
    const page = await context.newPage();
    await page.clock.install({ time: date });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes("private-location-probe")) errors.push("Location executed as markup");
      if (
        (path.startsWith("/api/bookings") || path === "/api/events/default/bookings") &&
        request.method() === "POST"
      )
        posts.push(request);
      if (path === "/api/owner/events/default" && request.method() === "PATCH")
        saves.push(request.postDataJSON());
    });
    return page;
  };
  const where = (page) => page.locator("dt").getByText("Where", { exact: true });
  const hidden = async (page) => {
    assert.equal(await where(page).count(), 0);
    assert.equal(await page.getByText("Add to calendar", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Other", exact: true }).count(), 0);
  };
  const facts = async (page) => {
    await where(page).waitFor();
    const value = where(page).locator("xpath=following-sibling::dd[1]");
    assert.equal(await value.textContent(), location);
    assert.equal(await value.evaluate((node) => getComputedStyle(node).whiteSpace), "pre-wrap");
    assert.equal(await value.locator("img,script,a").count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  };
  const exports = async (page, booking) => {
    const writes = fixture.google.writes.length,
      mutations = posts.length;
    for (const name of ["Google", "Microsoft Outlook", "Microsoft Office"]) {
      const link = page.getByRole("link", { name, exact: true });
      const url = new URL(await link.getAttribute("href"));
      assert.deepEqual(url.searchParams.getAll("location"), [location]);
      assert.equal(url.searchParams.get(name === "Google" ? "text" : "subject"), booking.title);
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.match(await link.getAttribute("rel"), /noopener/);
    }
    const other = page.getByRole("link", { name: "Other", exact: true });
    await other.focus();
    const downloading = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "booking.ics");
    const ics = (await readFile(await download.path())).toString("utf8");
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
    const lines = ics.replace(/\r\n /g, "").split("\r\n");
    assert.ok(
      lines.includes(
        `LOCATION:${location.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, "\\$&")}`
      )
    );
    assert.ok(lines.includes(`UID:${booking.id}@calflare.invalid`));
    assert.ok(lines.includes(`SEQUENCE:${booking.version}`));
    for (const [property, instant] of [
      ["DTSTART", booking.start],
      ["DTEND", booking.end],
    ])
      assert.ok(
        lines.includes(`${property}:${new Date(instant).toISOString().replace(/[-:]|\.\d{3}/g, "")}`)
      );
    assert.doesNotMatch(ics, /\r\n(?:ATTENDEE|ORGANIZER|DESCRIPTION|URL):/);
    for (const value of [booking.email, booking.name, booking.manageToken, "private-notes", "#token="])
      if (value) assert.ok(!ics.includes(value));
    assert.equal(posts.length, mutations);
    assert.equal(fixture.google.writes.length, writes);
  };
  try {
    await fixture.read(await fixture.send("/api/owner", fixture.settings, owner, "PUT"));
    const editor = await open(true);
    await editor.goto(fixture.origin);
    const input = editor.getByLabel("Location", { exact: true });
    const save = editor
      .locator('form[action="/api/owner/events/default"]')
      .getByRole("button", { name: "Save", exact: true });
    await expect(input).toBeEnabled();
    await editor.locator('label[for="event-location"]').click();
    assert.ok(await input.evaluate((node) => node === document.activeElement));
    assert.equal(await input.getAttribute("maxlength"), null);
    await input.fill("x".repeat(1001));
    await save.press("Enter");
    await editor.getByRole("alert").waitFor();
    assert.equal(await input.inputValue(), "x".repeat(1001));
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    assert.match(await editor.locator("#event-location-limit").textContent(), /1000/);
    assert.equal(saves.length, 0);
    await input.fill(` \n${"😀".repeat(500)}\t `);
    await save.click();
    await editor.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal(saves.at(-1).location, "😀".repeat(500));
    await editor.reload();
    await expect(input).toHaveValue("😀".repeat(500));
    await expect(input).toBeEnabled();
    await input.fill(` \n${location}\t `);
    await editor.route(
      "**/api/owner/events/default",
      (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
          : route.continue(),
      { times: 1 }
    );
    await save.click();
    await editor.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    assert.equal(await input.inputValue(), ` \n${location}\t `);
    await save.click();
    await editor.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    await editor.reload();
    await expect(input).toHaveValue(location);
    for (const width of [390, 1280]) {
      await editor.setViewportSize({ width, height: 900 });
      assert.ok(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    const configured = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    assert.deepEqual(configured, { ...fixture.settings, event: { ...fixture.settings.event, location } });
    const source = await open();
    await source.goto(`${fixture.origin}/${fixture.settings.event.slug}`);
    await source.getByTestId("time").first().waitFor();
    assert.ok(!(await source.content()).includes("Room-private-marker"));
    assert.ok(!(await (await fixture.request("/api/public")).text()).includes("Room-private-marker"));
    await source.getByTestId("time").first().press("Enter");
    await source.getByLabel("Your name*", { exact: true }).fill("Location Guest");
    await source.getByLabel("Email address*", { exact: true }).fill("location@example.test");
    await source.getByLabel("Additional notes", { exact: false }).fill("private-notes");
    const created = source.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/events/default/bookings" &&
        response.request().method() === "POST"
    );
    await source.getByRole("button", { name: "Confirm", exact: true }).click();
    const response = await created,
      booking = await response.json();
    assert.equal(response.status(), 201);
    assert.equal(booking.location, location);
    assert.equal(Object.hasOwn(response.request().postDataJSON(), "location"), false);
    await facts(source);
    const guest = await open();
    const link = `${fixture.origin}/booking/${booking.id}#token=${booking.manageToken}`;
    await guest.goto(link);
    await facts(guest);
    await guest.reload();
    await facts(guest);
    const ownerPage = await open(true);
    await ownerPage.goto(`${fixture.origin}/owner/bookings/${booking.id}`);
    for (const width of [390, 1280]) {
      for (const page of [source, guest, ownerPage]) {
        await page.setViewportSize({ width, height: 900 });
        await facts(page);
      }
      await exports(source, booking);
      await exports(guest, booking);
    }
    const denied = await open();
    for (const path of [`/booking/${booking.id}`, `/owner/bookings/${booking.id}`]) {
      await denied.goto(`${fixture.origin}${path}`);
      if (path.startsWith("/booking/")) await denied.getByRole("alert").waitFor();
      await hidden(denied);
      assert.ok(!(await denied.content()).includes("Room-private-marker"));
    }
    const restoring = await browser.newContext({ javaScriptEnabled: false });
    contexts.push(restoring);
    await restoring.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    const staticPage = await restoring.newPage();
    await staticPage.goto(`${fixture.origin}/owner/bookings/${booking.id}`);
    await hidden(staticPage);
    for (const next of ["Room B", " \n\t "]) {
      await expect(input).toBeEnabled();
      await input.fill(next);
      await save.click();
      await editor.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      await editor.reload();
      await expect(input).toHaveValue(next.trim());
      for (const page of [source, guest, ownerPage]) {
        await page.reload();
        await facts(page);
      }
      await exports(guest, booking);
      assert.equal(fixture.google.events.get(booking.id).location, location);
    }
    assert.equal(saves.at(-1).location, "");
    const canonical = await fixture.read(
      await fixture.request(`/api/owner/bookings/${booking.id}`, { headers: owner })
    );
    for (const field of ["id", "title", "start", "end", "timeZone", "location"])
      assert.equal(canonical[field], booking[field]);
    const blocked = await open();
    await blocked.addInitScript(() => {
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith("calflare:change:")) throw new Error("Blocked change storage");
        return read.call(this, key);
      };
    });
    await blocked.goto(link);
    await blocked.getByRole("alert").waitFor();
    await hidden(blocked);
    await guest.getByRole("button", { name: "Reschedule", exact: true }).click();
    await hidden(guest);
    await guest.getByTestId("time").first().click();
    const path = `/api/bookings/${booking.id}`;
    await guest.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const result = await route.fetch();
      assert.equal(result.status(), 200);
      await route.fulfill({ status: 200, contentType: "application/json", body: "truncated" });
    });
    await guest.getByRole("button", { name: "Reschedule", exact: true }).click();
    await guest.getByRole("alert").waitFor();
    await hidden(guest);
    await guest.reload();
    await guest.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await hidden(guest);
    await guest.unroute(`**${path}`);
    const writes = fixture.google.writes.length;
    await guest.getByRole("button", { name: "Retry", exact: true }).click();
    await facts(guest);
    assert.equal(fixture.google.writes.length, writes);
    const moved = await fixture.read(
      await fixture.request(path, { headers: { Authorization: `Bearer ${booking.manageToken}` } })
    );
    assert.equal(moved.location, location);
    assert.equal(moved.end - moved.start, booking.end - booking.start);
    await exports(guest, moved);
    fixture.google.loseResponseAfter("delete");
    await guest.getByRole("button", { name: "Cancel event", exact: true }).click();
    await guest.getByRole("button", { name: "Cancel event", exact: true }).click();
    await guest
      .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
      .waitFor();
    await hidden(guest);
    await ownerPage.reload();
    await hidden(ownerPage);
    await guest.getByRole("button", { name: "Check booking status", exact: true }).click();
    await guest.getByRole("heading", { name: "Canceled", exact: true }).waitFor();
    await hidden(guest);
    await ownerPage.reload();
    await hidden(ownerPage);
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    assert.deepEqual(
      fixture.google.writes.slice(initialWrites).map((write) => write.action),
      ["insert", "update", "delete"]
    );
    assert.equal(
      posts.filter((request) => new URL(request.url()).pathname === "/api/events/default/bookings").length,
      1
    );
    console.log(
      "PASS static location editor validation/retry/clear, private UI booking facts, historical move/reload and actual ICS/composer exports at 390/1280; denied, blocked, pending, attention and cancelled omission. Built Worker/local D1; Google is mocked."
    );
  } finally {
    for (const context of contexts) await context.close();
  }
}
