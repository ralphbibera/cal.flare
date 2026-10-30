import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyDefaultDialogs, verifyDialogTypography } from "./verify-upstream.mjs";

export async function verifySubmission(browser, fixture, date) {
  await verifyDefaultDialogs(browser);
  const contexts = [],
    errors = [],
    consoles = [];
  const requests = [];
  const bodies = [];
  const notes = "First line\nSecond line <plain> & text\nThird line";
  const note = (page) => page.getByLabel("Additional notes", { exact: true });
  const guest = (page, index) => page.getByLabel(`Guest email ${index}`, { exact: true });
  const values = (page) =>
    page.locator('input[name^="guests."]').evaluateAll((inputs) => inputs.map((input) => input.value));
  const recipients = ["second@example.test", "first@example.test"];
  const addGuests = async (page) => {
    await page.getByRole("button", { name: "Add guests", exact: true }).press("Enter");
    assert.ok(await guest(page, 1).evaluate((input) => document.activeElement === input));
    await guest(page, 1).fill("  SECOND@EXAMPLE.TEST  ");
    await page.getByRole("button", { name: "Add another", exact: true }).press("Enter");
    assert.ok(await guest(page, 2).evaluate((input) => document.activeElement === input));
    await guest(page, 2).fill("first@example.test");
    assert.deepEqual(await values(page), recipients);
  };
  const open = async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: "UTC",
      extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.86" },
    });
    contexts.push(context);
    const page = await context.newPage();
    await page.clock.install({ time: date });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoles.push({ text: message.text(), url: message.location().url });
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/events/default/bookings" && request.method() === "POST") {
        requests.push(request.postDataJSON());
        bodies.push(request.postData());
      }
    });
    await page.goto(`${fixture.origin}/${fixture.settings.event.slug}`);
    await page.getByTestId("time").first().click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "name");
    await page.locator('label[for="booker-email"]').click();
    assert.ok(
      await page
        .getByLabel("Email address*", { exact: true })
        .evaluate((node) => document.activeElement === node)
    );
    await page.locator('label[for="booker-name"]').click();
    assert.ok(
      await page.getByLabel("Your name*", { exact: true }).evaluate((node) => document.activeElement === node)
    );
    await page.getByLabel("Your name*", { exact: true }).fill("Fixture Guest");
    await page.getByLabel("Email address*", { exact: true }).fill("guest@example.test");
    assert.equal(await page.locator("textarea").count(), 1);
    assert.deepEqual(
      await page.locator("form [name]").evaluateAll((nodes) => nodes.map((node) => node.name)),
      ["name", "email", "notes"]
    );
    await page.locator('label[for="notes"]').click();
    assert.deepEqual(
      await note(page).evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          focused: document.activeElement === node,
          id: node.id,
          name: node.name,
          rows: node.rows,
          required: node.required,
          max: node.getAttribute("maxlength"),
          placeholder: node.placeholder,
          font: style.fontSize,
          line: style.lineHeight,
          weight: style.fontWeight,
          min: style.minHeight,
          radius: style.borderRadius,
          x: style.paddingLeft,
          y: style.paddingTop,
          resize: style.resize,
        };
      }),
      {
        focused: true,
        id: "notes",
        name: "notes",
        rows: 3,
        required: false,
        max: null,
        placeholder: "Please share anything that will help prepare for our meeting.",
        font: "14px",
        line: "20px",
        weight: "400",
        min: "80px",
        radius: "10px",
        x: "12px",
        y: "8px",
        resize: "vertical",
      }
    );
    await note(page).fill("First line");
    await note(page).press("Enter");
    await page.keyboard.insertText("Second line <plain> & text\nThird line");
    assert.equal(await note(page).inputValue(), notes);
    return page;
  };
  const saved = (page) =>
    page.evaluate(() => JSON.parse(sessionStorage.getItem("calflare:create:v2:default")));
  try {
    const page = await open();
    await verifyDialogTypography(page);
    const license = await page.request.get(`${fixture.origin}/fonts/CalSans-OFL.txt`);
    assert.equal(license.status(), 200, "Cal Sans distributed license response");
    assert.equal(
      await license.text(),
      await readFile(new URL("../public/fonts/CalSans-OFL.txt", import.meta.url), "utf8"),
      "Served Cal Sans full license and copyright notice"
    );
    assert.equal(await page.getByRole("button", { name: "Add guests", exact: true }).count(), 1);
    await page.evaluate(() => {
      window.guestStorageWrites = 0;
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args) {
        window.guestStorageWrites++;
        return write.apply(this, args);
      };
    });
    for (let index = 0; index < 140; index++) {
      await page.getByRole("button", { name: index ? "Add another" : "Add guests", exact: true }).click();
      await guest(page, index + 1).fill(`${"a".repeat(235)}${index}@example.test`);
    }
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Remove some guest rows" }).waitFor();
    assert.equal(requests.length, 0);
    assert.equal(await saved(page), null);
    assert.equal(await page.evaluate(() => window.guestStorageWrites), 0);
    assert.ok(await page.getByLabel("Your name*", { exact: true }).isEditable());
    assert.equal(await note(page).inputValue(), notes);
    for (let index = 140; index > 0; index--)
      await page.getByRole("button", { name: `Remove guest ${index}`, exact: true }).click();
    await addGuests(page);
    await page.getByRole("button", { name: "Add another", exact: true }).click();
    await guest(page, 3).fill("last@example.test");
    await page.getByRole("button", { name: "Remove guest 2", exact: true }).press("Enter");
    assert.deepEqual(await values(page), ["second@example.test", "last@example.test"]);
    assert.ok(await guest(page, 2).evaluate((input) => document.activeElement === input));
    await page.getByRole("button", { name: "Remove guest 2", exact: true }).press("Enter");
    assert.ok(await guest(page, 1).evaluate((input) => document.activeElement === input));
    await guest(page, 1).fill("");
    assert.deepEqual(await values(page), [""]);
    await page.getByRole("button", { name: "Remove guest 1", exact: true }).press("Enter");
    assert.ok(
      await page
        .getByRole("button", { name: "Add guests", exact: true })
        .evaluate((button) => document.activeElement === button)
    );
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByTestId("time").nth(1).click();
    assert.deepEqual(await values(page), []);
    assert.ok(await page.getByRole("button", { name: "Add guests", exact: true }).isVisible());
    await addGuests(page);
    assert.deepEqual(
      await guest(page, 1).evaluate((input) => ({
        type: input.type,
        autocomplete: input.autocomplete,
        mode: input.inputMode,
        capitalize: input.autocapitalize,
        required: input.required,
        max: input.getAttribute("maxlength"),
        height: input.getBoundingClientRect().height,
        radius: getComputedStyle(input).borderRadius,
        size: getComputedStyle(input).fontSize,
        weight: getComputedStyle(input).fontWeight,
      })),
      {
        type: "email",
        autocomplete: "email",
        mode: "email",
        capitalize: "none",
        required: false,
        max: null,
        height: 32,
        radius: "10px",
        size: "14px",
        weight: "500",
      }
    );
    for (const bad of ["second@example.test", "", "malformed", `${"a".repeat(243)}@example.test`]) {
      await guest(page, 2).fill(bad);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      assert.equal(await guest(page, 2).getAttribute("aria-invalid"), "true");
      assert.equal(
        await page.getByRole("group", { name: "Guests", exact: true }).getAttribute("aria-invalid"),
        "true"
      );
      assert.ok(await page.getByRole("alert").isVisible());
      if (bad === "malformed")
        await page.screenshot({
          path: new URL("../.verification/booking-guests-error.png", import.meta.url).pathname,
          fullPage: true,
          animations: "disabled",
        });
      assert.equal(await saved(page), null);
      assert.equal(requests.length, 0);
    }
    await guest(page, 2).fill("first@example.test");
    await page.getByRole("button", { name: "Add another", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm your details", exact: true });
    for (const width of [390, 768, 769, 1024, 1025, 1280]) {
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByTestId("time").first().waitFor();
      await page.setViewportSize({ width, height: 844 });
      await page.getByTestId("time").first().click();
      if (width <= 768) {
        await dialog.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "name");
        await page.keyboard.press("Shift+Tab");
        assert.ok(await page.evaluate(() => document.activeElement === document.body));
        for (const name of [
          "Your name*",
          "Email address*",
          "Additional notes",
          "Guest email 1",
          "Remove guest 1",
          "Guest email 2",
          "Remove guest 2",
          "Guest email 3",
          "Remove guest 3",
          "Add another",
          "Terms",
          "Privacy Policy",
          "Back",
          "Confirm",
        ]) {
          await page.keyboard.press("Tab");
          let control = page.getByLabel(name, { exact: true });
          if (["Terms", "Privacy Policy"].includes(name))
            control = page.getByRole("link", { name, exact: true });
          if (
            ["Confirm", "Back", "Add another", "Remove guest 1", "Remove guest 2", "Remove guest 3"].includes(
              name
            )
          )
            control = page.getByRole("button", { name, exact: true });
          assert.ok(await control.evaluate((node) => document.activeElement === node), `Tab focuses ${name}`);
          assert.ok(
            await dialog.evaluate(
              (node) => node.contains(document.activeElement) || document.activeElement === document.body
            ),
            "Native modal keyboard navigation never reaches background controls"
          );
        }
        await page.keyboard.press("Tab");
        assert.ok(
          await dialog.evaluate(
            (node) => node.contains(document.activeElement) || document.activeElement === document.body
          ),
          "Native modal keyboard navigation never reaches background controls"
        );
        await page.keyboard.press("Tab");
        assert.ok(
          await page
            .getByLabel("Your name*", { exact: true })
            .evaluate((node) => document.activeElement === node)
        );
        await page.keyboard.press("Shift+Tab");
        assert.ok(await page.evaluate(() => document.activeElement === document.body));
        await page.keyboard.press("Shift+Tab");
        assert.ok(
          await page
            .getByRole("button", { name: "Confirm", exact: true })
            .evaluate((node) => document.activeElement === node)
        );
        await page.keyboard.press("Shift+Tab");
        assert.ok(
          await page
            .getByRole("button", { name: "Back", exact: true })
            .evaluate((node) => document.activeElement === node)
        );
        await page.keyboard.press("Escape");
        await page.getByTestId("time").first().waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "time");
        await page.getByTestId("time").first().click();
        await page.getByRole("button", { name: "Back", exact: true }).click();
      } else {
        assert.equal(await dialog.count(), 0);
        assert.equal(
          (await page.getByTestId("booker-container").boundingBox()).width,
          width < 1024 ? 660 : 760
        );
        assert.equal((await page.locator("form").boundingBox()).width, 371);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.keyboard.press("Escape");
        assert.ok(await page.getByLabel("Your name*", { exact: true }).isVisible());
        await page.getByRole("button", { name: "Back", exact: true }).click();
      }
      await page.getByTestId("time").first().waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "time");
      await page.getByTestId("time").first().click();
      assert.equal(await page.getByLabel("Your name*", { exact: true }).inputValue(), "Fixture Guest");
      assert.equal(await note(page).inputValue(), notes);
      assert.deepEqual(await values(page), [...recipients, ""]);
    }
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByTestId("time").nth(1).click();
    assert.equal(await note(page).inputValue(), notes);
    assert.deepEqual(await values(page), [...recipients, ""]);
    await page.screenshot({
      path: new URL("../.verification/booking-notes-desktop.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("radio", { name: "Switch to weekly view", exact: true }).click();
    await page.locator("[data-slot]").first().click();
    await dialog.waitFor();
    await verifyDialogTypography(page);
    assert.equal(await note(page).inputValue(), notes);
    await page.screenshot({
      path: new URL("../.verification/booking-notes-week.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.locator("[data-slot]").first().click();
    assert.equal(await note(page).inputValue(), notes);
    assert.deepEqual(await values(page), [...recipients, ""]);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("radio", { name: "Switch to column view", exact: true }).click();
    await page.getByTestId("time").first().click();
    assert.deepEqual(await values(page), [...recipients, ""]);
    await page.screenshot({
      path: new URL("../.verification/booking-guests-column.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await page.mouse.click(1, 1);
    await page.getByTestId("time").first().click();
    assert.deepEqual(await values(page), [...recipients, ""]);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("radio", { name: "Switch to monthly view", exact: true }).click();
    await page.getByTestId("time").first().click();
    assert.equal(requests.length, 0);
    await page.setViewportSize({ width: 390, height: 240 });
    await dialog.waitFor();
    assert.ok(
      await dialog.evaluate(
        (node) => node.clientHeight <= innerHeight * 0.8 && node.scrollHeight > node.clientHeight
      ),
      "Small-screen attendee dialog has bounded, scrollable content"
    );
    await page.getByRole("button", { name: "Confirm", exact: true }).focus();
    assert.ok(
      await dialog.evaluate((node) => {
        const footer = node.querySelector('button[type="submit"]').parentElement.getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        return footer.top >= bounds.top && footer.bottom <= bounds.bottom;
      }),
      "Sticky actions remain visible in a short viewport"
    );
    await page.getByLabel("Your name*", { exact: true }).focus();
    assert.ok(
      await page.getByLabel("Your name*", { exact: true }).evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const dialog = node.closest("dialog");
        const footer = dialog.querySelector(".modalsticky").getBoundingClientRect();
        return bounds.top >= dialog.getBoundingClientRect().top && bounds.bottom <= footer.top;
      }),
      "Fields remain reachable above the sticky footer"
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.click(1, 1);
    await page.getByTestId("time").first().click();
    await dialog.waitFor();
    assert.equal(await page.getByLabel("Email address*", { exact: true }).inputValue(), "guest@example.test");
    assert.equal(await note(page).inputValue(), notes);
    assert.deepEqual(await values(page), [...recipients, ""]);
    await page.getByRole("button", { name: "Remove guest 3", exact: true }).click();
    for (const invalidName of ["", "   "]) {
      await page.getByLabel("Your name*", { exact: true }).fill(invalidName);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      assert.ok(
        await page
          .getByLabel("Your name*", { exact: true })
          .evaluate((input) => document.activeElement === input)
      );
      assert.equal(requests.length, 0);
    }
    await page.getByLabel("Your name*", { exact: true }).fill("Fixture Guest");
    await page.getByLabel("Email address*", { exact: true }).fill("invalid");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    assert.equal(requests.length, 0);
    assert.ok(
      await page
        .getByLabel("Email address*", { exact: true })
        .evaluate((input) => document.activeElement === input)
    );
    await page.getByLabel("Email address*", { exact: true }).fill("guest@example.test");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByTestId("time").first().click();
    assert.equal(await page.getByLabel("Your name*", { exact: true }).inputValue(), "Fixture Guest");
    assert.equal(await page.getByLabel("Email address*", { exact: true }).inputValue(), "guest@example.test");
    await page.screenshot({
      path: new URL("../.verification/booking-form-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    const applied = Promise.withResolvers();
    const acknowledge = Promise.withResolvers();
    await page.route("**/api/events/default/bookings", async (route) => {
      try {
        const response = await route.fetch();
        applied.resolve({ status: response.status(), booking: await response.json() });
        await acknowledge.promise;
        await route.fulfill({ status: 200, contentType: "application/json", body: "truncated" });
      } catch (error) {
        applied.reject(error);
      }
    });
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    const original = await applied.promise;
    assert.equal(original.status, 201);
    assert.deepEqual(requests[0].guests, recipients);
    assert.deepEqual(fixture.google.events.get(original.booking.id).attendees, [
      { email: "guest@example.test", displayName: "Fixture Guest" },
      { email: "second@example.test" },
      { email: "first@example.test" },
    ]);
    assert.ok(!JSON.stringify(original.booking).includes("second@example.test"));
    assert.ok(!Object.hasOwn(original.booking, "guests"));
    assert.equal(
      fixture.google.events.get(original.booking.id).description,
      `<img src="/unexpected-image" onerror="alert(1)">\n\nAdditional notes:\n${notes}`
    );
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    assert.ok(await dialog.isVisible());
    assert.ok(await page.getByRole("button", { name: "Back", exact: true }).isDisabled());
    assert.equal(requests.length, 1);
    acknowledge.resolve();
    await page.getByRole("alert").waitFor();
    const pending = await saved(page);
    assert.equal(pending.kind, "pending");
    assert.equal(pending.request.requestKey, requests[0].requestKey);
    assert.equal(pending.request.notes, notes);
    assert.deepEqual(pending.request.guests, recipients);
    assert.ok(await guest(page, 1).evaluate((input) => input.readOnly));
    assert.equal(await page.getByRole("button", { name: "Add another", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Remove guest/ }).count(), 0);
    assert.equal(fixture.google.writes.length, 1);
    assert.ok(await page.getByRole("button", { name: "Back", exact: true }).isDisabled());
    assert.ok(await page.getByLabel("Your name*", { exact: true }).evaluate((input) => input.readOnly));
    assert.ok(await page.getByLabel("Email address*", { exact: true }).evaluate((input) => input.readOnly));
    assert.ok(await note(page).evaluate((input) => input.readOnly));
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.waitFor({ state: "hidden" });
    await page.getByLabel("Your name*", { exact: true }).waitFor();
    assert.equal(await dialog.count(), 0);
    assert.equal((await page.getByTestId("booker-container").boundingBox()).width, 760);
    assert.equal((await page.locator("form").boundingBox()).width, 371);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(await saved(page), pending);
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    assert.ok(await dialog.isVisible());
    assert.deepEqual(await saved(page), pending);
    assert.equal(await page.getByLabel("Time zone", { exact: true }).count(), 0);
    assert.equal(await page.getByTestId("event-meta").getByText("UTC", { exact: true }).count(), 1);
    await page.unroute("**/api/events/default/bookings");
    await page.reload();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Email address*", { exact: true }).inputValue(), "guest@example.test");
    assert.equal(await note(page).inputValue(), notes);
    assert.deepEqual(await values(page), recipients);
    assert.ok(await guest(page, 2).evaluate((input) => input.readOnly));
    assert.ok(await note(page).evaluate((input) => input.readOnly));
    assert.deepEqual(await saved(page), pending);
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    assert.ok(await dialog.isVisible());
    assert.equal(requests.length, 1);
    for (const method of ["getItem", "setItem"]) {
      const beforeRetry = requests.length;
      await page.evaluate((method) => {
        window.restoreGuestStorage = Storage.prototype[method];
        Storage.prototype[method] = () => {
          throw new DOMException("Blocked", "SecurityError");
        };
      }, method);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByRole("alert").waitFor();
      await page.evaluate((method) => {
        Storage.prototype[method] = window.restoreGuestStorage;
      }, method);
      assert.deepEqual(await saved(page), pending);
      assert.deepEqual(await values(page), recipients);
      assert.ok(await guest(page, 1).evaluate((input) => input.readOnly));
      assert.equal(fixture.google.writes.length, 1);
      assert.equal(requests.length, beforeRetry + (method === "getItem" ? 0 : 1));
    }
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(requests.length, 3);
    for (const body of bodies) assert.equal(body, bodies[0]);
    assert.equal(fixture.google.writes.length, 1);
    const receipt = await saved(page);
    assert.deepEqual(Object.keys(receipt).sort(), ["access", "eventId", "kind", "requestKey"]);
    assert.equal(receipt.eventId, "default");
    assert.equal(receipt.access.id, original.booking.id);
    assert.ok(!JSON.stringify(receipt).includes("guest@example.test"));
    assert.ok(!JSON.stringify(receipt).includes("Fixture Guest"));
    assert.ok(!JSON.stringify(receipt).includes("First line"));
    assert.ok(!JSON.stringify(receipt).includes('"notes"'));
    for (const email of recipients) assert.ok(!JSON.stringify(receipt).includes(email));
    const projection = await fixture.request(`/api/bookings/${receipt.access.id}`, {
      headers: { Authorization: `Bearer ${receipt.access.token}` },
    });
    assert.ok(!(await projection.text()).includes("second@example.test"));
    await page.reload();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(requests.length, 3);
    assert.equal(fixture.google.writes.length, 1);
    assert.ok(!(await page.content()).includes(receipt.access.token));
    assert.ok(!page.url().includes(receipt.access.token));
    await page.route(`**/api/bookings/${receipt.access.id}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "truncated" })
    );
    await page.reload();
    await page
      .getByRole("heading", { name: "Booking status is currently unavailable.", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "This booking is not confirmed yet.", exact: true }).count(),
      0
    );
    await page.unroute(`**/api/bookings/${receipt.access.id}`);
    await page.getByRole("button", { name: "Check booking status", exact: true }).click();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(fixture.google.writes.length, 1);
    await page.screenshot({
      path: new URL("../.verification/booking-receipt-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    assert.equal(await fixture.db.prepare("SELECT count(*) FROM booking").first("count(*)"), 1);
    const uncertain = await open();
    await uncertain.getByRole("button", { name: "Add guests", exact: true }).click();
    await uncertain.getByRole("button", { name: "Add another", exact: true }).click();
    fixture.google.loseResponseAfter("insert");
    await uncertain.getByRole("button", { name: "Confirm", exact: true }).click();
    await uncertain
      .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
      .waitFor();
    assert.equal((await saved(uncertain)).kind, "receipt");
    assert.equal(
      await uncertain.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
      0
    );
    assert.equal(fixture.google.writes.length, 2);
    assert.ok(!Object.hasOwn(requests[3], "guests"));
    await uncertain.reload();
    await uncertain
      .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
      .waitFor();
    await uncertain.getByRole("button", { name: "Check booking status", exact: true }).click();
    await uncertain.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(fixture.google.writes.length, 2);
    const conflict = await open();
    await addGuests(conflict);
    const start = Date.parse(
      await conflict.getByTestId("event-meta").locator("time").getAttribute("datetime")
    );
    fixture.google.events.set("external-conflict", {
      id: "external-conflict",
      etag: '"external"',
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + 30 * 60_000).toISOString() },
    });
    await conflict.getByRole("button", { name: "Confirm", exact: true }).click();
    await conflict.getByRole("alert").filter({ hasText: "The event or time has changed" }).waitFor();
    assert.deepEqual(await saved(conflict), { kind: "empty", eventId: "default" });
    assert.ok(await conflict.getByRole("button", { name: "Back", exact: true }).isEnabled());
    await conflict.getByRole("button", { name: "Back", exact: true }).click();
    await conflict.getByTestId("time").first().click();
    assert.equal(await conflict.getByLabel("Your name*", { exact: true }).inputValue(), "Fixture Guest");
    assert.equal(await note(conflict).inputValue(), notes);
    assert.deepEqual(await values(conflict), recipients);
    assert.equal(fixture.google.writes.length, 2);
    const before = requests.length;
    await conflict.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
    });
    await conflict.getByRole("button", { name: "Confirm", exact: true }).click();
    await conflict
      .getByRole("alert")
      .filter({ hasText: "We couldn't restore or save this booking safely" })
      .waitFor();
    assert.equal(requests.length, before);
    assert.equal(fixture.google.writes.length, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      consoles.filter(
        (error) =>
          !(
            error.url === `${fixture.origin}/api/events/default/bookings` &&
            error.text.startsWith("Failed to load resource: the server responded with a status of 409")
          )
      ),
      []
    );
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    console.log(
      "PASS native attendee submission, persisted lost-response replay, receipt reload/PII removal, uncertain provider acknowledgment, conflict recovery and storage rejection. Actual built Worker/local D1; Google is mocked."
    );
  } finally {
    for (const context of contexts) await context.close();
  }
}
