import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { hour } from "./fixtures/api.ts";
import { createWorkerFixture } from "./verify-worker.mjs";

const f = await createWorkerFixture({ port: 8797 });
try {
  const { request, send, read, google, db } = f;
  const owner = await f.login();
  await read(await send("/api/owner", f.settings, owner, "PUT"));
  const details = {
    slug: "second-event",
    title: "Second event",
    description: "B description",
    durationMinutes: 45,
    location: "Private B room 東京",
  };
  const created = await read(await send("/api/owner/events", details, owner), 201);
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  const ownerPath = `/api/owner/events/${created.id}`;
  const publicPath = `/api/events/${created.id}`;
  const rules = {
    intervalMinutes: 30,
    beforeMinutes: 0,
    afterMinutes: 0,
    noticeMinutes: 0,
    disableCancelling: false,
    disableRescheduling: false,
  };
  await read(await send(`${ownerPath}/booking-rules`, rules, owner, "PATCH"));
  assert.equal((await read(await request("/api/owner/events", { headers: owner }))).events.length, 2);
  const metadata = await read(await request(publicPath));
  assert.equal(metadata.id, created.id);
  assert.equal(metadata.event.title, "Second event");
  assert.equal(metadata.event.location, undefined);
  assert.equal(metadata.conflictCalendarIds, undefined);
  for (const secret of [
    ...Object.values(f.secrets),
    ...google.secrets,
    "Private B room",
    "organizer@example.test",
  ])
    assert.ok(!JSON.stringify(metadata).includes(secret));
  assert.equal((await request("/second-event")).status, 404, "Event B public UI is deferred");
  assert.equal((await request("/intro")).status, 200);
  const start = Math.ceil((Date.now() + 24 * hour) / hour) * hour;
  const query = new URLSearchParams({
    from: new Date(start).toISOString(),
    to: new Date(start + 3 * hour).toISOString(),
    timeZone: "UTC",
  });
  const slots = (await read(await request(`${publicPath}/slots?${query}`))).slots;
  assert.equal(slots[0].start, start);
  assert.equal(slots[0].end, start + 45 * 60_000);
  const input = {
    requestKey: randomUUID(),
    start,
    name: "Historical B guest",
    email: "guest@example.test",
    timeZone: "UTC",
    notes: "Keep B notes",
    guests: ["other@example.test"],
  };
  const booked = await read(await send(`${publicPath}/bookings`, input), 201);
  assert.equal(booked.title, "Second event");
  assert.equal(booked.location, details.location);
  assert.equal(booked.end, start + 45 * 60_000);
  const remote = structuredClone(google.events.get(booked.id));
  assert.equal(remote.summary, "Second event");
  assert.equal(remote.location, details.location);
  assert.match(remote.description, /Keep B notes/);
  assert.deepEqual(remote.attendees.map((a) => a.email).sort(), ["guest@example.test", "other@example.test"]);
  const beforeMismatch = (await db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
  assert.equal((await read(await send("/api/bookings", input), 409)).error, "idempotency_mismatch");
  assert.deepEqual(
    (await db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
    beforeMismatch
  );
  assert.equal(google.writes.length, 1);
  await read(await send(`${publicPath}/bookings`, input), 201);
  assert.equal(google.writes.length, 1);
  await read(
    await send(
      ownerPath,
      { ...details, slug: "renamed-second", title: "Future B", durationMinutes: 90, location: "Future room" },
      owner,
      "PATCH"
    )
  );
  assert.equal((await read(await request(publicPath))).event.slug, "renamed-second");
  await read(
    await send(
      "/api/owner",
      { ...f.settings, event: { ...f.settings.event, disableCancelling: true, disableRescheduling: true } },
      owner,
      "PUT"
    )
  );
  const auth = { Authorization: `Bearer ${booked.manageToken}` };
  const moved = await read(
    await send(
      `/api/bookings/${booked.id}`,
      { action: "reschedule", requestKey: randomUUID(), version: 1, start: start + hour },
      auth
    )
  );
  assert.equal(moved.title, "Second event");
  assert.equal(moved.end - moved.start, 45 * 60_000);
  assert.equal(moved.location, details.location);
  assert.equal(google.events.get(booked.id).summary, remote.summary);
  assert.equal(google.events.get(booked.id).description, remote.description);
  assert.equal(google.events.get(booked.id).location, remote.location);
  const ownerBooking = await read(await request(`/api/owner/bookings/${booked.id}`, { headers: owner }));
  assert.equal(ownerBooking.disableRescheduling, false);
  assert.equal(ownerBooking.title, "Second event");
  const frozenInput = { ...input, requestKey: randomUUID(), start: start + 4 * hour };
  google.loseResponseAfter("insert");
  const pending = await read(await send(`${publicPath}/bookings`, frozenInput), 202);
  assert.equal(pending.status, "attention");
  const frozen = await db
    .prepare("SELECT settings_json,desired_json FROM booking_command WHERE booking_id=?")
    .bind(pending.id)
    .first();
  await read(
    await send(
      `${ownerPath}/booking-rules`,
      { ...rules, bookingWindowDays: 1, noticeMinutes: 43200 },
      owner,
      "PATCH"
    )
  );
  await read(await send("/api/owner/schedule", { timeZone: "UTC", rules: [] }, owner, "PATCH"));
  await db.prepare("UPDATE event_type SET json='{}' WHERE id='default'").run();
  await db
    .prepare("UPDATE booking_command SET due=0,lease_until=0 WHERE booking_id=?")
    .bind(pending.id)
    .run();
  await f.scheduled();
  const recovered = await read(
    await request(`/api/bookings/${pending.id}`, {
      headers: { Authorization: `Bearer ${pending.manageToken}` },
    })
  );
  assert.equal(recovered.status, "confirmed");
  assert.equal(recovered.title, "Future B");
  assert.equal(recovered.location, "Future room");
  assert.deepEqual(
    await db
      .prepare("SELECT settings_json,desired_json FROM booking_command WHERE booking_id=?")
      .bind(pending.id)
      .first(),
    frozen
  );
  assert.equal(google.writes.filter((w) => w.id === pending.id).length, 1);
  assert.deepEqual(f.upstreamFailures, []);
  assert.deepEqual(google.denied, []);
  process.stdout.write(
    "PASS built Worker event routes, owner OAuth session, real Google adapter with mocked HTTP, event identity, historical moves and global scheduled recovery. UI switching and live Google remain unverified.\n"
  );
} finally {
  await f.close();
}
