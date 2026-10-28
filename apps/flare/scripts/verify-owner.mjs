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
    const save = page.getByRole("button", { name: "Save", exact: true });
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
    assert.deepEqual(fixture.google.denied, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    console.log(
      "PASS native private owner bookings, confirmed/moved/canceled/attention states, read-only viewing, anonymous privacy and corrupt-data redaction without JavaScript. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}
