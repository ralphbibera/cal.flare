import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { apiFixture, hour } from "./fixtures/api.ts";

test("calendar prefetch crosses months through HTTP/D1 and rejects oversized ranges before Calendar work", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  let reads = 0;
  const original = fixture.calendar.busy.bind(fixture.calendar);
  fixture.calendar.busy = (...args) => {
    reads++;
    return original(...args);
  };
  const client = new BookerClient((path, init) => fixture.request(path, init));
  const from = fixture.now();
  const to = from + 63 * 24 * hour;
  const slots = await client.slots({ from, to, timeZone: "UTC" });
  assert.equal(slots.length, 18_139);
  assert.deepEqual(slots[0], { start: from, end: from + 0.5 * hour });
  assert.deepEqual(slots.at(-1), { start: to - 0.5 * hour, end: to });
  assert.equal(reads, 1);
  await assert.rejects(client.slots({ from, to: to + 1, timeZone: "UTC" }), (error: unknown) => {
    assert.ok(error instanceof ErrorWithCode);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_range");
    return true;
  });
  assert.equal(reads, 1);
});

test("calendar decoder accepts the full bounded minute grid and rejects an extra result", async () => {
  const from = Date.UTC(2030, 0, 1);
  const slots = Array.from({ length: 90_720 }, (_, index) => ({
    start: from + index * 60_000,
    end: from + (index + 1) * 60_000,
  }));
  const client = new BookerClient(async () => Response.json({ slots }));
  const request = { from, to: from + 63 * 24 * hour, timeZone: "UTC" };
  assert.deepEqual(await client.slots(request), slots);
  slots.push({ start: request.to, end: request.to + 60_000 });
  await assert.rejects(
    client.slots(request),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
  );
});

test("booker client completes the booking lifecycle through HTTP and migrated D1", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new BookerClient((path, init) => {
    calls.push({ path, init });
    const headers = new Headers(init.headers);
    headers.set("Origin", fixture.env.PUBLIC_ORIGIN);
    return fixture.request(path, { ...init, headers });
  });
  const data = await client.publicData();
  assert.deepEqual(data.organizer, { name: "Organizer" });
  assert.equal(data.event.slug, "intro");
  const start = fixture.now() + 10 * hour;
  assert.ok(
    (await client.slots({ from: start, to: start + 2 * hour, timeZone: "UTC" })).some(
      (slot) => slot.start === start
    )
  );
  const input = {
    requestKey: crypto.randomUUID(),
    start,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  };
  fixture.calendar.cutAfter = "insert";
  const pending = await client.create(input);
  assert.equal(pending.status, "attention");
  assert.equal(pending.pendingAction, "create");
  const access = { id: pending.id, token: pending.manageToken };
  const confirmed = await client.retry(access);
  assert.equal(confirmed.status, "confirmed");
  assert.equal((await client.create(input)).id, confirmed.id);
  assert.equal(fixture.calendar.writes.length, 1);
  await assert.rejects(client.create({ ...input, name: "Changed" }), (error: unknown) => {
    assert.ok(error instanceof ErrorWithCode);
    assert.equal(error.code, "idempotency_mismatch");
    assert.equal(error.status, 409);
    assert.equal(error.retryable, false);
    return true;
  });
  const view = await client.view(access);
  assert.equal(view.start, start);
  assert.equal(view.manageToken, undefined);
  assert.ok(
    (await client.slots({ from: start, to: start + 2 * hour, timeZone: "UTC", access })).some(
      (slot) => slot.start === start
    )
  );
  const moved = await client.change(access, {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: view.version,
    start: start + 2 * hour,
  });
  assert.equal(moved.status, "confirmed");
  assert.equal(moved.start, start + 2 * hour);
  assert.equal(moved.id, access.id);
  fixture.calendar.cutAfter = "delete";
  const cancelling = await client.change(access, {
    action: "cancel",
    requestKey: crypto.randomUUID(),
    version: moved.version,
  });
  assert.equal(cancelling.status, "attention");
  assert.equal((await client.retry(access)).status, "cancelled");
  assert.equal(fixture.calendar.events.size, 0);
  assert.deepEqual(
    fixture.calendar.writes.map((write) => write.action),
    ["insert", "update", "delete"]
  );
  assert.ok(
    calls.every(
      ({ path, init }) =>
        !path.includes(access.token) &&
        init.credentials === "same-origin" &&
        init.cache === "no-store" &&
        init.redirect === "error"
    )
  );
  const exclusion = calls.find(({ path }) => path.includes("bookingId="));
  assert.ok(exclusion);
  assert.equal(new Headers(exclusion.init.headers).get("Authorization"), `Bearer ${access.token}`);
  const posts = calls.filter(({ path }) => path === "/api/bookings");
  assert.equal(posts[0]?.init.body, posts[1]?.init.body);
});

test("booker client distinguishes uncertain outcomes and sanitizes failures", async () => {
  for (const status of [400, 401, 404, 408, 409, 429, 503]) {
    const client = new BookerClient(async () =>
      Response.json({ error: "failure", message: "private detail" }, { status })
    );
    await assert.rejects(client.publicData(), (error: unknown) => {
      assert.ok(error instanceof ErrorWithCode);
      assert.equal(error.status, status);
      assert.equal(error.retryable, [408, 429, 503].includes(status));
      assert.equal(error.message, "failure");
      return true;
    });
  }
  const failed = new BookerClient(async () => {
    throw new Error("private network detail");
  });
  await assert.rejects(
    failed.publicData(),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "network_error" && error.retryable
  );
  for (const value of [null, { organizer: { name: "Organizer" } }]) {
    const malformed = new BookerClient(async () => Response.json(value));
    await assert.rejects(
      malformed.publicData(),
      (error: unknown) =>
        error instanceof ErrorWithCode && error.code === "invalid_response" && error.retryable
    );
  }
});

test("booker client rejects inconsistent booking data and discards unknown fields", async () => {
  const access = { id: "a".repeat(64), token: "b".repeat(43) };
  const valid = {
    id: access.id,
    status: "confirmed",
    version: 1,
    start: Date.UTC(2030, 0, 1),
    end: Date.UTC(2030, 0, 1, 0, 30),
    name: "Guest",
    email: "guest@example.test",
    title: "Call",
    timeZone: "UTC",
  };
  const client = new BookerClient(async () => Response.json({ ...valid, credential: "private" }));
  assert.deepEqual(await client.view(access), valid);
  for (const key of ["disableCancelling", "disableRescheduling"] as const) {
    for (const value of [true, false]) {
      const payload = { ...valid, [key]: value };
      assert.deepEqual(await new BookerClient(async () => Response.json(payload)).view(access), payload);
    }
    for (const value of [null, "false", "true", 0, 1, [], {}]) {
      const malformed = new BookerClient(async () => Response.json({ ...valid, [key]: value }));
      await assert.rejects(
        malformed.view(access),
        (error: unknown) =>
          error instanceof ErrorWithCode && error.code === "invalid_response" && error.retryable
      );
    }
  }
  for (const change of [
    { status: "unknown" },
    { pendingAction: "create" },
    { status: "pending" },
    { status: "rescheduling", pendingAction: "cancel" },
    { status: "attention", pendingAction: "create" },
    { error: "unexpected" },
    { version: -1 },
    { id: "other" },
    { end: valid.start },
    { start: -1 },
    { end: Number.MAX_SAFE_INTEGER },
    { timeZone: "invalid" },
  ]) {
    const malformed = new BookerClient(async () => Response.json({ ...valid, ...change }));
    await assert.rejects(
      malformed.view(access),
      (error: unknown) =>
        error instanceof ErrorWithCode && error.code === "invalid_response" && error.retryable
    );
  }
  const noToken = new BookerClient(async () => Response.json(valid, { status: 201 }));
  await assert.rejects(
    noToken.create({
      requestKey: crypto.randomUUID(),
      start: valid.start,
      name: valid.name,
      email: valid.email,
      timeZone: valid.timeZone,
    }),
    (error: unknown) =>
      error instanceof ErrorWithCode &&
      error.code === "invalid_response" &&
      error.status === 201 &&
      error.retryable
  );
  const badSlots = new BookerClient(async () =>
    Response.json({ slots: [{ start: valid.start, end: valid.start }] })
  );
  await assert.rejects(
    badSlots.slots({ from: valid.start, to: valid.end, timeZone: "UTC" }),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
  );
  let calls = 0;
  const untouched = new BookerClient(async () => {
    calls++;
    return Response.json(valid);
  });
  assert.throws(() => untouched.view({ ...access, token: "invalid" }), ErrorWithCode);
  assert.throws(() => untouched.retry({ ...access, id: "../owner" }), ErrorWithCode);
  assert.equal(calls, 0);
});
