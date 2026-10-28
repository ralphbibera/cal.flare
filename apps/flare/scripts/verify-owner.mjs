import assert from "node:assert/strict";

export async function verifyOwner(browser, fixture) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    javaScriptEnabled: false,
  });
  const errors = [];
  let consent = 0;
  const check = async (response, status) => {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    return response.text();
  };
  const email = "organizer@example.test";
  try {
    const anonymous = await check(await fixture.request("/"), 200);
    assert.ok(!anonymous.includes(email));
    const invalid = await check(
      await fixture.request("/", {
        headers: { Cookie: `flare_session=${"A".repeat(43)}` },
      }),
      200
    );
    assert.ok(!invalid.includes(email));
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await context.route("https://accounts.google.com/**", async (route) => {
      errors.push("Unexpected live Google browser request");
      await route.abort();
    });
    await page.route(
      (url) => url.origin === fixture.origin && url.pathname === "/api/auth/login",
      async (route) => {
        try {
          consent++;
          const response = await route.fetch({ maxRedirects: 0 });
          assert.equal(response.status(), 303);
          const headers = response.headers();
          const url = new URL(headers.location);
          const callback = new URL("/api/auth/callback", fixture.origin);
          callback.search = new URLSearchParams({
            state: url.searchParams.get("state"),
            code: fixture.google.authorize(url),
          }).toString();
          await route.fulfill({ response, headers: { ...headers, location: callback.href } });
        } catch (error) {
          errors.push(error.name);
          await route.abort();
        }
      }
    );
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
    assert.equal(consent, 1);
    assert.equal(page.url(), `${fixture.origin}/`);
    assert.ok((await page.textContent("body")).includes(email));
    await page.getByRole("heading", { name: "Bookings", exact: true }).waitFor();
    assert.ok(
      await page
        .getByRole("form", { name: "Date overrides", exact: true })
        .getByRole("button", { name: "Save", exact: true })
        .isDisabled()
    );
    assert.ok(
      await page
        .getByRole("form", { name: "Booking rules", exact: true })
        .getByRole("button", { name: "Save", exact: true })
        .isDisabled()
    );
    assert.ok((await page.textContent("body")).includes("As soon as someone books a time with you"));
    const sessions = (await context.cookies(fixture.origin)).filter(
      (cookie) => cookie.name === "flare_session"
    );
    assert.equal(sessions.length, 1);
    const session = sessions[0];
    assert.ok(session.httpOnly);
    assert.equal(session.sameSite, "Lax");
    const ownerHeaders = { Cookie: `${session.name}=${session.value}` };
    const privateHtml = await check(await fixture.request("/", { headers: ownerHeaders }), 200);
    assert.ok(privateHtml.includes(email));
    for (const value of [session.value, ...fixture.google.secrets, ...Object.values(fixture.secrets)])
      assert.ok(!privateHtml.includes(value));
    const settings = (await fixture.read(await fixture.request("/api/owner", { headers: ownerHeaders })))
      .settings;
    await fixture.read(
      await fixture.send(
        "/api/owner",
        {
          ...settings,
          event: { ...settings.event, title: "x".repeat(100) },
        },
        ownerHeaders,
        "PUT"
      )
    );
    await page.reload();
    for (const width of [390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await fixture.read(await fixture.send("/api/owner", settings, ownerHeaders, "PUT"));
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: new URL("../.verification/owner-home-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("link", { name: "Preview", exact: true }).click();
    await page.getByTestId("event-title").waitFor();
    assert.equal(new URL(page.url()).pathname, `/${fixture.settings.event.slug}`);
    assert.ok(!(await page.content()).includes(email));
    await page.goto(fixture.origin);
    await fixture.db.prepare("UPDATE organizer_settings SET json='{}' WHERE id='owner'").run();
    const unavailable = await check(await fixture.request("/", { headers: ownerHeaders }), 503);
    assert.ok(unavailable.includes("Organizer sign-in is currently unavailable."));
    assert.ok(!unavailable.includes(email));
    assert.ok(!unavailable.includes(session.value));
    await fixture.db.prepare("DELETE FROM organizer_settings WHERE id='owner'").run();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with Google", exact: true }).waitFor();
    assert.equal(page.url(), `${fixture.origin}/`);
    assert.equal(await fixture.db.prepare("SELECT count(*) FROM owner_session").first("count(*)"), 0);
    assert.equal((await fixture.request("/api/owner", { headers: ownerHeaders })).status, 401);
    assert.ok(!(await check(await fixture.request("/", { headers: ownerHeaders }), 200)).includes(email));
    await page.reload();
    assert.ok(!(await page.content()).includes(email));
    assert.equal(fixture.google.writes.length, 0);
    assert.deepEqual(fixture.google.denied, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(errors, []);
    console.log(
      "PASS native organizer sign-in, OAuth redirect landing, private SSR, event preview and revoked-session sign-out without JavaScript. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
  await verifyEventEditor(browser, fixture);
  await verifyWeeklyEditor(browser, fixture);
  await verifyOverridesEditor(browser, fixture);
  await verifyBookingRulesEditor(browser, fixture);
}

async function verifyEventEditor(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const owner = await fixture.login();
    await context.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    const original = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    const page = await context.newPage();
    const errors = [],
      attempts = [];
    let fail = true;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)"))
        errors.push(message.text());
    });
    await page.route("**/api/owner", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts.push(route.request().postDataJSON());
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"private-fixture-detail"}',
        });
      return route.continue();
    });
    await page.goto(fixture.origin);
    const save = page.locator('form[action="/api/owner"]').getByRole("button", { name: "Save", exact: true });
    await save.waitFor();
    await page.getByLabel("Slug", { exact: true }).fill("api");
    await save.click();
    await page.getByRole("alert").waitFor();
    assert.equal(attempts.length, 0);
    const details = {
      title: "Edited organizer event",
      slug: "edited-event",
      description: "A saved description",
      durationMinutes: 45,
    };
    await page.getByLabel("Title", { exact: true }).fill(details.title);
    await page.getByLabel("Slug", { exact: true }).fill(details.slug);
    await page.getByLabel("Description", { exact: true }).fill(details.description);
    await page.getByLabel("Duration (Minutes)", { exact: true }).fill(String(details.durationMinutes));
    await save.click();
    await page.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), details.title);
    assert.ok(!(await page.content()).includes("private-fixture-detail"));
    assert.equal(
      await page.getByRole("link", { name: "Preview", exact: true }).getAttribute("href"),
      `/${original.event.slug}`
    );
    fail = false;
    await save.click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.deepEqual(attempts, [details, details]);
    await page.reload();
    assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), details.title);
    assert.equal(await page.getByLabel("Description", { exact: true }).inputValue(), details.description);
    assert.equal(await page.getByLabel("Duration (Minutes)", { exact: true }).inputValue(), "45");
    assert.equal((await fixture.request(`/${original.event.slug}`)).status, 404);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: new URL("../.verification/owner-editor-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("link", { name: "Preview", exact: true }).click();
    await page.getByTestId("event-title").waitFor();
    assert.equal(await page.getByTestId("event-title").textContent(), details.title);
    assert.ok((await page.getByTestId("event-meta").textContent()).includes("45"));
    assert.ok((await page.getByTestId("event-meta").textContent()).includes(details.description));
    assert.equal(fixture.google.writes.length, 0);
    assert.deepEqual(errors, []);
    assert.equal((await fixture.send("/api/owner", original, owner, "PUT")).status, 200);
    console.log(
      "PASS organizer details save, validation, failed-save draft retention, explicit retry, reload and public preview. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}

export async function verifyOwnerBookings(browser, fixture) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    javaScriptEnabled: false,
  });
  try {
    const owner = await fixture.login();
    await context.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    assert.equal(
      (
        await fixture.send(
          "/api/owner",
          { ...fixture.settings, schedule: { ...fixture.settings.schedule, timeZone: "Asia/Kolkata" } },
          owner,
          "PUT"
        )
      ).status,
      200
    );
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 12);
    const input = {
      requestKey: crypto.randomUUID(),
      start,
      name: "<img src=x>" + "x".repeat(180),
      email: "owner-list-guest@example.test",
      timeZone: "UTC",
    };
    const first = await fixture.read(
      await fixture.send("/api/bookings", input, { "CF-Connecting-IP": "192.0.2.46" }),
      201
    );
    const bearer = { Authorization: `Bearer ${first.manageToken}` };
    const page = await context.newPage();
    const row = page
      .getByRole("list", { name: "Bookings", exact: true })
      .getByRole("listitem")
      .filter({ hasText: input.email });
    await page.goto(fixture.origin);
    assert.ok((await row.textContent()).includes("Confirmed"));
    assert.equal(await row.locator("time").getAttribute("datetime"), new Date(start).toISOString());
    assert.ok((await row.textContent()).includes(input.name));
    assert.equal(await row.locator("img").count(), 0);
    assert.ok((await row.textContent()).includes("5:30"));
    assert.ok((await page.textContent("body")).includes("Timezone: Asia/Kolkata"));
    const moved = await fixture.read(
      await fixture.send(
        `/api/bookings/${first.id}`,
        {
          action: "reschedule",
          requestKey: crypto.randomUUID(),
          version: first.version,
          start: start + 3_600_000,
        },
        bearer
      )
    );
    await page.reload();
    assert.equal(await row.locator("time").getAttribute("datetime"), new Date(moved.start).toISOString());
    await fixture.read(
      await fixture.send(
        `/api/bookings/${first.id}`,
        { action: "cancel", requestKey: crypto.randomUUID(), version: moved.version },
        bearer
      )
    );
    await page.reload();
    assert.ok((await row.textContent()).includes("Canceled"));
    fixture.google.loseResponseAfter("insert");
    const pending = await fixture.read(
      await fixture.send(
        "/api/bookings",
        {
          ...input,
          requestKey: crypto.randomUUID(),
          start: start + 7_200_000,
          name: "Pending guest",
          email: "owner-list-pending@example.test",
        },
        { "CF-Connecting-IP": "192.0.2.46" }
      ),
      202
    );
    const writes = fixture.google.writes.length;
    const before = (
      await fixture.db.prepare("SELECT * FROM booking_command WHERE booking_id=?").bind(pending.id).all()
    ).results;
    await page.reload();
    const pendingRow = page.getByRole("listitem").filter({ hasText: "owner-list-pending@example.test" });
    assert.ok((await pendingRow.textContent()).includes("Needs organizer attention"));
    assert.ok(
      await pendingRow.getByRole("button", { name: "Retry pending operation", exact: true }).isDisabled()
    );
    assert.equal(
      fixture.google.writes.length,
      writes,
      "Viewing the owner list cannot retry pending operations"
    );
    assert.deepEqual(
      (await fixture.db.prepare("SELECT * FROM booking_command WHERE booking_id=?").bind(pending.id).all())
        .results,
      before
    );
    for (const width of [390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: new URL("../.verification/owner-bookings-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    const html = await page.content();
    for (const value of [
      first.manageToken,
      pending.manageToken,
      ...fixture.google.secrets,
      ...Object.values(fixture.secrets),
    ])
      assert.ok(!html.includes(value));
    const anonymous = await fixture.request("/");
    assert.equal(anonymous.status, 200);
    const publicHtml = await anonymous.text();
    for (const value of [input.email, "owner-list-pending@example.test"])
      assert.ok(!publicHtml.includes(value));
    const stored = await fixture.db
      .prepare("SELECT initial_json FROM booking WHERE id=?")
      .bind(pending.id)
      .first("initial_json");
    await fixture.db.prepare("UPDATE booking SET initial_json='{}' WHERE id=?").bind(pending.id).run();
    const unavailable = await fixture.request("/", { headers: owner });
    assert.equal(unavailable.status, 503);
    assert.ok(!(await unavailable.text()).includes(input.email));
    await fixture.db.prepare("UPDATE booking SET initial_json=? WHERE id=?").bind(stored, pending.id).run();
    await verifyOwnerRecovery(browser, fixture, owner, pending);
    assert.deepEqual(fixture.google.denied, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    console.log(
      "PASS native private owner bookings, confirmed/moved/canceled/attention states, read-only viewing, anonymous privacy and corrupt-data redaction without JavaScript. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}

async function verifyOwnerRecovery(browser, fixture, owner, booking) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    const page = await context.newPage();
    const errors = [],
      requests = [],
      statuses = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !(
          message.location().url === `${fixture.origin}/api/owner/retry` &&
          message.text().startsWith("Failed to load resource: net::ERR_FAILED")
        )
      )
        errors.push(message.text());
    });
    const email = "owner-list-pending@example.test";
    const row = page.getByRole("listitem").filter({ hasText: email });
    const retry = row.getByRole("button", { name: "Retry pending operation", exact: true });
    const writes = fixture.google.writes.length;
    const commandCount = () =>
      fixture.db
        .prepare("SELECT count(*) FROM booking_command WHERE booking_id=?")
        .bind(booking.id)
        .first("count(*)");
    assert.equal((await fixture.send("/api/owner/retry", { id: booking.id })).status, 401);
    assert.equal(
      (
        await fixture.send(
          "/api/owner/retry",
          { id: booking.id },
          { ...owner, Origin: "https://foreign.example" }
        )
      ).status,
      403
    );
    await page.goto(fixture.origin);
    assert.equal(fixture.google.writes.length, writes);
    assert.equal(await commandCount(), 1);
    await retry.click();
    await row.getByText("Confirmed", { exact: true }).waitFor();
    assert.equal(await retry.count(), 0);
    assert.equal(
      fixture.google.writes.length,
      writes,
      "Reconcile the acknowledged insert without another provider write"
    );
    assert.equal(await commandCount(), 1);
    const access = { Authorization: `Bearer ${booking.manageToken}` };
    const current = await fixture.read(
      await fixture.request(`/api/bookings/${booking.id}`, { headers: access })
    );
    fixture.google.loseResponseAfter("delete");
    const pending = await fixture.read(
      await fixture.send(
        `/api/bookings/${booking.id}`,
        {
          action: "cancel",
          requestKey: crypto.randomUUID(),
          version: current.version,
        },
        access
      ),
      202
    );
    assert.equal(pending.status, "attention");
    const afterDelete = fixture.google.writes.length;
    assert.ok(!fixture.google.events.has(booking.id));
    let lose = true;
    await page.route("**/api/owner/retry", async (route) => {
      requests.push(route.request().postDataJSON());
      if (lose) {
        lose = false;
        const response = await route.fetch();
        statuses.push(response.status());
        await response.body();
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.reload();
    await retry.click();
    await row.getByRole("alert").waitFor();
    assert.deepEqual(statuses, [200]);
    assert.equal(
      await fixture.db.prepare("SELECT state FROM booking WHERE id=?").bind(booking.id).first("state"),
      "cancelled"
    );
    assert.equal(fixture.google.writes.length, afterDelete);
    assert.equal(await commandCount(), 2);
    await retry.click();
    await row.getByText("Canceled", { exact: true }).waitFor();
    assert.deepEqual(requests, [{ id: booking.id }, { id: booking.id }]);
    assert.equal(await retry.count(), 0);
    assert.equal(fixture.google.writes.length, afterDelete, "A repeated owner retry cannot delete twice");
    assert.equal(await commandCount(), 2);
    assert.ok(!(await page.content()).includes(booking.manageToken));
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: new URL("../.verification/owner-recovered-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    console.log(
      "PASS explicit owner recovery, authorization, lost-response replay and confirmed/canceled refresh without duplicate Calendar writes or new commands. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}

async function verifyWeeklyEditor(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
  try {
    const owner = await fixture.login();
    await context.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    const original = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    const now = new Date();
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2);
    const weekday = new Date(day).getUTCDay();
    const overrides = [{ date: new Date(day + 7 * 86_400_000).toISOString().slice(0, 10), ranges: [] }];
    await fixture.read(
      await fixture.send(
        "/api/owner",
        { ...original, schedule: { ...original.schedule, overrides } },
        owner,
        "PUT"
      )
    );
    const page = await context.newPage();
    const errors = [],
      requests = [];
    let fail = true;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !(
          message.location().url === `${fixture.origin}/api/owner/schedule` &&
          message.text().startsWith("Failed to load resource: the server responded with a status of 503")
        )
      )
        errors.push(message.text());
    });
    await page.route("**/api/owner/schedule", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      requests.push(route.request().postDataJSON());
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"private-schedule-detail"}',
        });
      return route.continue();
    });
    await page.goto(fixture.origin);
    const form = page.getByRole("form", { name: "Working hours", exact: true });
    const save = form.getByRole("button", { name: "Save", exact: true });
    const remove = form.getByRole("button", { name: "Remove", exact: true });
    while (await remove.count()) await remove.first().click();
    const zone = form.getByLabel("Time zone", { exact: true });
    const india = await zone.evaluate((select) =>
      ["Asia/Kolkata", "Asia/Calcutta"].find((name) =>
        [...select.options].some((option) => option.value === name)
      )
    );
    assert.ok(india);
    await zone.selectOption(india);
    const add = form.getByRole("button", { name: "Add", exact: true });
    const fill = async (index, dayNumber, start, end) => {
      const row = form.getByRole("group", { name: `Interval ${index}`, exact: true });
      await row.getByLabel("Day", { exact: true }).selectOption(String(dayNumber));
      await row.getByLabel("Start time", { exact: true }).fill(start);
      await row.getByLabel("End time", { exact: true }).fill(end);
    };
    await add.click();
    await fill(1, weekday, "09:00", "10:00");
    await add.click();
    await fill(2, weekday, "09:30", "11:00");
    await save.click();
    await form.getByRole("alert").waitFor();
    assert.equal(requests.length, 0, "Invalid overlapping hours cannot reach HTTP");
    await fill(2, weekday, "10:30", "11:00");
    await add.click();
    await fill(3, (weekday + 1) % 7, "00:00", "00:00");
    await save.click();
    await form.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    assert.equal(await zone.inputValue(), india);
    assert.equal(
      await form
        .getByRole("group", { name: "Interval 2", exact: true })
        .getByLabel("Start time")
        .inputValue(),
      "10:30"
    );
    assert.ok(!(await page.content()).includes("private-schedule-detail"));
    fail = false;
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const weekly = {
      timeZone: india,
      rules: [
        { weekday, startMinute: 540, endMinute: 600 },
        { weekday, startMinute: 630, endMinute: 660 },
        { weekday: (weekday + 1) % 7, startMinute: 0, endMinute: 1440 },
      ],
    };
    assert.deepEqual(requests, [weekly, weekly]);
    await page.reload();
    assert.equal(await zone.inputValue(), india);
    assert.equal(
      await form.getByRole("group", { name: "Interval 3", exact: true }).getByLabel("End time").inputValue(),
      "00:00"
    );
    const persisted = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    assert.deepEqual(persisted, { ...original, schedule: { ...original.schedule, ...weekly, overrides } });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await form.screenshot({
      path: new URL("../.verification/working-hours-mobile.png", import.meta.url).pathname,
      animations: "disabled",
    });
    const publicPage = await context.newPage();
    await publicPage.goto(`${fixture.origin}/${original.event.slug}`);
    await publicPage.getByTestId("time").first().waitFor();
    assert.deepEqual(
      await publicPage
        .getByTestId("time")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-time"))),
      [210, 240, 300, ...Array.from({ length: 11 }, (_, index) => 1110 + index * 30)].map((minute) =>
        new Date(day + minute * 60_000).toISOString()
      )
    );
    await publicPage.close();
    while (await remove.count()) await remove.first().click();
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const closed = await fixture.read(
      await fixture.request(
        `/api/slots?${new URLSearchParams({ from: new Date(day).toISOString(), to: new Date(day + 86_400_000).toISOString(), timeZone: "UTC" })}`
      )
    );
    assert.deepEqual(closed, { slots: [] });
    assert.equal(fixture.google.writes.length, 0);
    assert.deepEqual(errors, []);
    await fixture.read(await fixture.send("/api/owner", original, owner, "PUT"));
    console.log(
      "PASS working-hours editor, interval add/remove, overlap rejection, failed-save draft retention/retry, timezone and midnight reload, preserved overrides and public availability. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}

async function verifyOverridesEditor(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
  try {
    const owner = await fixture.login();
    await context.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    const original = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    const now = new Date();
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2);
    const dates = [day, day + 86_400_000].map((value) => new Date(value).toISOString().slice(0, 10));
    const configured = {
      ...original,
      event: { ...original.event, intervalMinutes: 30, noticeMinutes: 0 },
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 540, endMinute: 600 })),
        overrides: [],
      },
    };
    await fixture.read(await fixture.send("/api/owner", configured, owner, "PUT"));
    const page = await context.newPage();
    const errors = [],
      requests = [];
    let fail = true;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !(
          message.location().url === `${fixture.origin}/api/owner/overrides` &&
          message.text().startsWith("Failed to load resource: the server responded with a status of 503")
        )
      )
        errors.push(message.text());
    });
    await page.route("**/api/owner/overrides", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      requests.push(route.request().postDataJSON());
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"private-override-detail"}',
        });
      return route.continue();
    });
    await page.goto(fixture.origin);
    const form = page.getByRole("form", { name: "Date overrides", exact: true });
    const save = form.getByRole("button", { name: "Save", exact: true });
    const addDate = form.getByRole("button", { name: "Add an override", exact: true });
    const row = (index) => form.getByRole("group", { name: `Date ${index}`, exact: true });
    await addDate.click();
    await row(1).getByLabel("Date", { exact: true }).fill(dates[0]);
    await addDate.click();
    await row(2).getByLabel("Date", { exact: true }).fill(dates[0]);
    await save.click();
    await form.getByRole("alert").waitFor();
    assert.equal(requests.length, 0, "Duplicate dates cannot reach HTTP");
    await row(2).getByLabel("Date", { exact: true }).fill(dates[1]);
    const range = (index) => row(2).getByRole("group", { name: `Interval ${index}`, exact: true });
    const fill = async (index, start, end) => {
      await range(index).getByLabel("Start time", { exact: true }).fill(start);
      await range(index).getByLabel("End time", { exact: true }).fill(end);
    };
    await row(2).getByRole("button", { name: "Add", exact: true }).click();
    await fill(1, "09:00", "10:00");
    await row(2).getByRole("button", { name: "Add", exact: true }).click();
    await fill(2, "09:30", "11:00");
    await save.click();
    await form.getByRole("alert").waitFor();
    assert.equal(requests.length, 0, "Overlapping override hours cannot reach HTTP");
    await fill(2, "10:30", "11:00");
    await row(2).getByRole("button", { name: "Add", exact: true }).click();
    await fill(3, "23:00", "00:00");
    await save.click();
    await form.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    assert.equal(await range(3).getByLabel("End time").inputValue(), "00:00");
    assert.ok(!(await page.content()).includes("private-override-detail"));
    fail = false;
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const overrides = [
      { date: dates[0], ranges: [] },
      {
        date: dates[1],
        ranges: [
          { startMinute: 540, endMinute: 600 },
          { startMinute: 630, endMinute: 660 },
          { startMinute: 1380, endMinute: 1440 },
        ],
      },
    ];
    assert.deepEqual(requests, [{ overrides }, { overrides }]);
    await page.reload();
    assert.equal(await row(1).getByLabel("Date", { exact: true }).inputValue(), dates[0]);
    assert.equal(await range(3).getByLabel("End time").inputValue(), "00:00");
    const readSettings = async () =>
      (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    assert.deepEqual(await readSettings(), {
      ...configured,
      schedule: { ...configured.schedule, overrides },
    });
    const slots = async (from) =>
      (
        await fixture.read(
          await fixture.request(
            `/api/slots?${new URLSearchParams({
              from: new Date(from).toISOString(),
              to: new Date(from + 86_400_000).toISOString(),
              timeZone: "UTC",
            })}`
          )
        )
      ).slots;
    const expected = (from, minutes) =>
      minutes.map((minute) => ({ start: from + minute * 60_000, end: from + (minute + 30) * 60_000 }));
    assert.deepEqual(await slots(day), []);
    assert.deepEqual(await slots(day + 86_400_000), expected(day + 86_400_000, [540, 570, 630, 1380, 1410]));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await form.screenshot({
      path: new URL("../.verification/date-overrides-mobile.png", import.meta.url).pathname,
      animations: "disabled",
    });
    await range(3).getByRole("button", { name: "Remove", exact: true }).click();
    await row(1).getByRole("button", { name: "Delete", exact: true }).click();
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.deepEqual(await slots(day), expected(day, [540, 570]));
    assert.deepEqual(await slots(day + 86_400_000), expected(day + 86_400_000, [540, 570, 630]));
    await row(1).getByRole("button", { name: "Delete", exact: true }).click();
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.deepEqual(await readSettings(), configured);
    assert.deepEqual(await slots(day + 86_400_000), expected(day + 86_400_000, [540, 570]));
    assert.equal(fixture.google.writes.length, 0);
    assert.deepEqual(errors, []);
    await fixture.read(await fixture.send("/api/owner", original, owner, "PUT"));
    console.log(
      "PASS native date overrides, closures/ranges, duplicate/overlap rejection, failed-save retry, midnight reload, removal and exact public slots. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}

async function verifyBookingRulesEditor(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
  const id = "a".repeat(32);
  try {
    const owner = await fixture.login();
    await context.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    const original = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    const now = new Date();
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2);
    const configured = {
      ...original,
      event: {
        ...original.event,
        durationMinutes: 30,
        intervalMinutes: 30,
        beforeMinutes: 0,
        afterMinutes: 0,
        noticeMinutes: 0,
      },
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
        overrides: [{ date: new Date(day + 7 * 86_400_000).toISOString().slice(0, 10), ranges: [] }],
      },
    };
    await fixture.read(await fixture.send("/api/owner", configured, owner, "PUT"));
    fixture.google.events.set(id, {
      id,
      etag: '"rules-busy"',
      start: { dateTime: new Date(day + 9 * 3_600_000).toISOString() },
      end: { dateTime: new Date(day + 10 * 3_600_000).toISOString() },
    });
    const page = await context.newPage();
    const errors = [],
      requests = [];
    let fail = true;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !(
          message.location().url === `${fixture.origin}/api/owner/booking-rules` &&
          message.text().startsWith("Failed to load resource: the server responded with a status of 503")
        )
      )
        errors.push(message.text());
    });
    await page.route("**/api/owner/booking-rules", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      requests.push(route.request().postDataJSON());
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"private-rules-detail"}',
        });
      return route.continue();
    });
    await page.goto(fixture.origin);
    const form = page.getByRole("form", { name: "Booking rules", exact: true });
    const save = form.getByRole("button", { name: "Save", exact: true });
    const field = (name) => form.getByRole("spinbutton", { name: `${name} (Minutes)`, exact: true });
    const cancelling = form.getByRole("checkbox", { name: "Disable Cancelling", exact: true });
    const rescheduling = form.getByRole("checkbox", { name: "Disable rescheduling", exact: true });
    assert.equal(await cancelling.isChecked(), false);
    assert.equal(await rescheduling.isChecked(), false);
    await field("Time-slot intervals").fill("4");
    await save.click();
    assert.equal(requests.length, 0);
    assert.ok(await field("Time-slot intervals").evaluate((input) => input.validity.rangeUnderflow));
    for (const [label, value] of [
      ["Time-slot intervals", "60"],
      ["Before event", "15"],
      ["After event", "20"],
      ["Minimum notice", "0"],
    ])
      await field(label).fill(value);
    await cancelling.check();
    await save.click();
    await form.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    assert.equal(await field("Time-slot intervals").inputValue(), "60");
    assert.equal(await cancelling.isChecked(), true);
    assert.ok(!(await page.content()).includes("private-rules-detail"));
    fail = false;
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const rules = {
      intervalMinutes: 60,
      beforeMinutes: 15,
      afterMinutes: 20,
      noticeMinutes: 0,
      disableCancelling: true,
      disableRescheduling: false,
    };
    assert.deepEqual(requests, [rules, rules]);
    await page.reload();
    assert.equal(await field("Time-slot intervals").inputValue(), "60");
    assert.equal(await cancelling.isChecked(), true);
    assert.equal(await rescheduling.isChecked(), false);
    const readSettings = async () =>
      (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    assert.deepEqual(await readSettings(), { ...configured, event: { ...configured.event, ...rules } });
    const slots = async () =>
      (
        await fixture.read(
          await fixture.request(
            `/api/slots?${new URLSearchParams({
              from: new Date(day + 8 * 3_600_000).toISOString(),
              to: new Date(day + 12 * 3_600_000).toISOString(),
              timeZone: "UTC",
            })}`
          )
        )
      ).slots;
    assert.deepEqual(
      await slots(),
      [8, 11].map((hours) => ({ start: day + hours * 3_600_000, end: day + hours * 3_600_000 + 30 * 60_000 }))
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await form.screenshot({
      path: new URL("../.verification/booking-rules-mobile.png", import.meta.url).pathname,
      animations: "disabled",
    });
    await field("Minimum notice").fill("43200");
    await cancelling.uncheck();
    await rescheduling.check();
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    await page.reload();
    assert.equal(await cancelling.isChecked(), false);
    assert.equal(await rescheduling.isChecked(), true);
    assert.deepEqual(await readSettings(), {
      ...configured,
      event: {
        ...configured.event,
        ...rules,
        noticeMinutes: 43200,
        disableCancelling: false,
        disableRescheduling: true,
      },
    });
    assert.deepEqual(await slots(), []);
    assert.equal(fixture.google.writes.length, 0);
    assert.deepEqual(errors, []);
    await fixture.read(await fixture.send("/api/owner", original, owner, "PUT"));
    console.log(
      "PASS native booking rules, validation, failed-save retry, reload, explicit checkbox values, preserved settings and spacing/buffer/notice availability. Built Worker/local D1; Google is mocked."
    );
  } finally {
    fixture.google.events.delete(id);
    await context.close();
  }
}
