import assert from "node:assert/strict";
import { test } from "node:test";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

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
