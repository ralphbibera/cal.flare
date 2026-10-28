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
}
