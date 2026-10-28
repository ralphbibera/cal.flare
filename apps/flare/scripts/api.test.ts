import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, type ChangeRequest, ErrorWithCode } from "../src/client/bookings.ts";
import { GoogleCalendarError } from "../src/server/google.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

test("current event policy refuses new guest changes without revoking durable outcomes", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { request, send, calendar, db, ownerHeaders } = fixture;
  const client = new BookerClient((path, init) =>
    request(path, {
      ...init,
      headers: { Origin: fixture.env.PUBLIC_ORIGIN, ...init.headers },
    })
  );
  let reads = 0;
  const busy = calendar.busy.bind(calendar),
    get = calendar.get.bind(calendar);
  calendar.busy = async (...args) => {
    reads++;
    return busy(...args);
  };
  calendar.get = async (...args) => {
    reads++;
    return get(...args);
  };
  const configure = async (disableCancelling: boolean, disableRescheduling: boolean) => {
    const next = { ...settings, event: { ...settings.event, disableCancelling, disableRescheduling } };
    const response = await send("/api/owner", next, ownerHeaders, "PUT");
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual((await client.publicData()).event, next.event);
  };
  const state = async (id: string) => ({
    booking: await db.prepare("SELECT * FROM booking WHERE id=?").bind(id).first(),
    reservations: (
      await db.prepare("SELECT * FROM booking_reservation WHERE booking_id=? ORDER BY role").bind(id).all()
    ).results,
    event: structuredClone(calendar.events.get(id)),
  });
  for (const [index, action] of ["cancel", "reschedule"].entries()) {
    assert.ok(action === "cancel" || action === "reschedule");
    await configure(false, false);
    const created = await client.create({
      requestKey: crypto.randomUUID(),
      start: fixture.now() + (10 + index * 24) * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    });
    assert.ok(created.manageToken);
    const access = { id: created.id, token: created.manageToken };
    const change: ChangeRequest =
      action === "cancel"
        ? { action, requestKey: crypto.randomUUID(), version: created.version }
        : {
            action,
            requestKey: crypto.randomUUID(),
            version: created.version,
            start: created.start + 2 * hour,
          };
    await configure(action === "cancel", action === "reschedule");
    const before = await state(created.id),
      beforeReads = reads,
      writes = calendar.writes.length;
    const denied = (error: unknown) =>
      error instanceof ErrorWithCode && error.status === 409 && error.code === "invalid_slot";
    await assert.rejects(client.change(access, change), denied);
    assert.equal(reads, beforeReads, "Disabled changes must not read Calendar");
    assert.equal(calendar.writes.length, writes);
    assert.deepEqual(await state(created.id), before);
    assert.equal(
      await db
        .prepare("SELECT outcome FROM booking_command WHERE request_key=?")
        .bind(change.requestKey)
        .first("outcome"),
      "invalid_slot"
    );
    await configure(false, false);
    await assert.rejects(client.change(access, change), denied);
    assert.equal(reads, beforeReads, "Re-enabling cannot change a persisted refusal");
    assert.deepEqual(await state(created.id), before);
    const allowed = { ...change, requestKey: crypto.randomUUID() };
    const result = await client.change(access, allowed);
    assert.equal(result.status, action === "cancel" ? "cancelled" : "confirmed");
    assert.equal(result.start, action === "cancel" ? created.start : created.start + 2 * hour);
    const acceptedWrites = calendar.writes.length;
    await configure(action === "cancel", action === "reschedule");
    assert.deepEqual(await client.change(access, allowed), result);
    assert.equal(calendar.writes.length, acceptedWrites, "Accepted replay survives a policy change");
    await configure(action !== "cancel", action !== "reschedule");
    const other = await client.create({
      requestKey: crypto.randomUUID(),
      start: fixture.now() + (18 + index * 24) * hour,
      name: "Other guest",
      email: "other@example.test",
      timeZone: "UTC",
    });
    assert.ok(other.manageToken);
    const otherChange: ChangeRequest =
      action === "cancel"
        ? { action, requestKey: crypto.randomUUID(), version: other.version }
        : { action, requestKey: crypto.randomUUID(), version: other.version, start: other.start + 2 * hour };
    const otherAccess = { id: other.id, token: other.manageToken };
    calendar.cutAfter = action === "cancel" ? "delete" : "update";
    assert.equal(
      (await client.change(otherAccess, otherChange)).status,
      "attention",
      "The other policy must not prevent admission or provider dispatch"
    );
    const afterDispatch = calendar.writes.length;
    await configure(true, true);
    const recovered = await client.change(otherAccess, otherChange);
    assert.equal(recovered.status, action === "cancel" ? "cancelled" : "confirmed");
    assert.equal(recovered.start, action === "cancel" ? other.start : other.start + 2 * hour);
    assert.equal(
      calendar.writes.length,
      afterDispatch,
      "An accepted uncertain change reconciles after policy changes without another write"
    );
  }
});

test("migrated booking flow runs over HTTP with local D1 and fixture Calendar", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { request, send, calendar, ownerHeaders } = fixture;
  const read = async (response: Response, status = 200) => {
    const text = await response.text();
    assert.equal(response.status, status, text);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return JSON.parse(text);
  };
  const publicData = await read(await request("/api/public"));
  assert.equal(publicData.organizer.name, "Organizer");
  assert.equal(JSON.stringify(publicData).includes(fixture.env.GOOGLE_OWNER_EMAIL), false);
  await read(await request("/api/owner"), 401);
  const updated = { ...settings, event: { ...settings.event, title: "Updated title" } };
  await read(await send("/api/owner", updated, ownerHeaders, "PUT"));
  const owner = await read(await request("/api/owner", { headers: ownerHeaders }));
  assert.equal(owner.settings.event.title, updated.event.title);
  for (const secret of [fixture.session, fixture.ciphertext, fixture.env.TOKEN_ENCRYPTION_KEY])
    assert.equal(JSON.stringify(owner).includes(secret), false);
  const start = fixture.now() + 10 * hour;
  const query = new URLSearchParams({
    from: new Date(fixture.now()).toISOString(),
    to: new Date(fixture.now() + 24 * hour).toISOString(),
    timeZone: "UTC",
  });
  const slots = await read(await request(`/api/slots?${query}`));
  assert.ok(slots.slots.some((slot: { start: number }) => slot.start === start));
  const input = {
    requestKey: crypto.randomUUID(),
    start,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  };
  await read(await send("/api/bookings", input, { Origin: "https://foreign.example" }), 403);
  const created = await read(await send("/api/bookings", input), 201);
  assert.equal(created.start, start);
  assert.deepEqual(await read(await send("/api/bookings", input), 201), created);
  assert.equal(calendar.writes.length, 1);
  const path = `/api/bookings/${created.id}`;
  const headers = { Authorization: `Bearer ${created.manageToken}` };
  await read(await request(path), 401);
  const denied = await read(
    await request(path, { headers: { Authorization: `Bearer ${"A".repeat(43)}` } }),
    404
  );
  assert.equal(JSON.stringify(denied).includes(input.email), false);
  const view = await read(await request(path, { headers }));
  assert.equal(view.title, updated.event.title);
  assert.equal("manageToken" in view, false);
  const move = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: view.version,
    start: start + 2 * hour,
  };
  const moved = await read(await send(path, move, headers));
  assert.equal(moved.start, move.start);
  assert.equal(moved.id, created.id);
  calendar.cutAfter = "delete";
  const pending = await read(
    await send(path, { action: "cancel", requestKey: crypto.randomUUID(), version: moved.version }, headers),
    202
  );
  assert.equal(pending.status, "attention");
  const cancelled = await read(await send("/api/owner/retry", { id: created.id }, ownerHeaders));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.id, created.id);
  assert.equal(calendar.events.size, 0);
  assert.deepEqual(
    calendar.writes.map((write) => [write.action, write.id]),
    [
      ["insert", created.id],
      ["update", created.id],
      ["delete", created.id],
    ]
  );
});

test("HTTP admission bounds Calendar work before availability and booking admission", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { request, send, calendar, db } = fixture;
  const busy = calendar.busy.bind(calendar);
  let calls = 0;
  const countedBusy: typeof calendar.busy = async (...args) => {
    calls++;
    return busy(...args);
  };
  calendar.busy = countedBusy;
  const path = `/api/slots?${new URLSearchParams({
    from: new Date(fixture.now()).toISOString(),
    to: new Date(fixture.now() + hour).toISOString(),
    timeZone: "UTC",
  })}`;
  const check = async (response: Response, status: number): Promise<void> => {
    assert.equal(response.status, status);
    const data = await response.json();
    assert.ok(typeof data === "object" && data !== null && !Array.isArray(data));
    if (status === 200) assert.ok("slots" in data && Array.isArray(data.slots) && data.slots.length > 0);
    if (status === 429) assert.equal("error" in data && data.error, "too_many_requests");
  };

  await t.test("one IP gets sixty availability requests and rejection does no Calendar work", async () => {
    for (let index = 0; index < 60; index++) {
      await check(await request(path), 200);
    }
    await check(await request(path), 429);
    assert.equal(calls, 60);
    await check(await request(path, { headers: { "CF-Connecting-IP": "192.0.2.2" } }), 200);
    assert.equal(calls, 61, "another IP can use the remaining global budget");
  });

  await t.test("one request key cannot bypass the minute limit after pre-admission failure", async () => {
    await db.prepare("DELETE FROM http_rate").run();
    calls = 0;
    calendar.busy = async (): Promise<never> => {
      calls++;
      throw new GoogleCalendarError("retryable", 503, "Fixture Calendar unavailable before admission");
    };
    const input = {
      requestKey: crypto.randomUUID(),
      start: fixture.now() + 10 * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    };
    for (let index = 0; index < 60; index++) await check(await send("/api/bookings", input), 503);
    await check(await send("/api/bookings", input), 429);
    assert.equal(calls, 60);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM booking_command").first("n"), 0);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM booking").first("n"), 0);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM http_attempt").first("n"), 1);
  });

  await t.test("different IPs compete atomically for the last global availability admission", async () => {
    await db.prepare("DELETE FROM http_rate").run();
    await db
      .prepare("INSERT INTO http_rate VALUES (?, 'slots:all', 599)")
      .bind(Math.floor(fixture.now() / 60_000))
      .run();
    calls = 0;
    calendar.busy = countedBusy;
    const responses = await Promise.all(
      ["192.0.2.3", "192.0.2.4"].map((ip) => request(path, { headers: { "CF-Connecting-IP": ip } }))
    );
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
    for (const response of responses) {
      if (response.status === 200) await check(response, 200);
      else await check(response, 429);
    }
    assert.equal(calls, 1, "the rejected global contender must not reach Calendar");
  });
});
