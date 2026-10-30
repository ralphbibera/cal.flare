import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { calendarExport } from "../src/client/calendar-export.ts";
import type { BookingSnapshot, BookingView } from "../src/server/booking-model.ts";
import { matches, parseChange, snapshot } from "../src/server/booking-model.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

const address = 'Room-private-marker\r\n東京 😀 <script>"&</script> Floor 2';
async function configure(f: Awaited<ReturnType<typeof apiFixture>>, location?: string) {
  const value = {
    ...settings,
    event: { ...settings.event, ...(location === undefined ? {} : { location }) },
  };
  assert.equal((await f.send("/api/owner", value, f.ownerHeaders, "PUT")).status, 200);
}

test("configured location freezes across settings edits, exact replay and attendee/owner moves", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  await configure(f, address);
  const client = new BookerClient((path, init) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", f.env.PUBLIC_ORIGIN);
    return f.request(path, { ...init, headers });
  });
  const owner = new BookerClient((path, init) =>
    f.request(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        ...f.ownerHeaders,
        Origin: f.env.PUBLIC_ORIGIN,
      },
    })
  );
  const input = {
    requestKey: "location-frozen-create",
    start: f.now() + 10 * hour,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
    notes: "Private notes",
  };
  const created = await client.create(input);
  assert.equal(created.status, "confirmed");
  assert.equal(created.location, address);
  assert.equal(f.calendar.events.get(created.id)?.location, address);
  const access = { id: created.id, token: created.manageToken };
  const stored = await f.db
    .prepare("SELECT initial_json,confirmed_json FROM booking WHERE id=?")
    .bind(created.id)
    .first<{ initial_json: string; confirmed_json: string }>();
  assert.ok(stored);
  const initial = snapshot(stored.initial_json);
  assert.equal(initial.location, address);
  assert.equal(snapshot(stored.confirmed_json).location, address);
  const command = await f.db
    .prepare("SELECT payload,desired_json FROM booking_command WHERE request_key=?")
    .bind(input.requestKey)
    .first<{ payload: string; desired_json: string }>();
  assert.ok(command);
  assert.equal(snapshot(command.desired_json).location, address);
  assert.equal(
    command.payload,
    `{"action":"create","requestKey":"location-frozen-create","start":${input.start},"name":"Guest","email":"guest@example.test","timeZone":"UTC","notes":"Private notes"}`
  );
  const edit = (location: string) =>
    f.send(
      "/api/owner",
      {
        ...settings,
        event: { ...settings.event, title: "Edited", durationMinutes: 60, location },
      },
      f.ownerHeaders,
      "PUT"
    );
  assert.equal((await edit("B")).status, 200);
  assert.equal((await client.create(input)).location, address);
  assert.equal(
    (await client.create({ ...input, requestKey: "location-new-value", start: input.start + 2 * hour }))
      .location,
    "B"
  );
  assert.equal((await edit(" ")).status, 200);
  assert.equal((await client.create(input)).location, address);
  const fresh = await client.create({
    ...input,
    requestKey: "location-new-blank",
    start: input.start + 4 * hour,
  });
  assert.equal(Object.hasOwn(fresh, "location"), false);
  assert.equal(Object.hasOwn(f.calendar.events.get(fresh.id) ?? {}, "location"), false);
  let moved = await client.change(access, {
    action: "reschedule",
    requestKey: "location-attendee-move",
    version: created.version,
    start: input.start + 6 * hour,
  });
  moved = await owner.ownerReschedule(created.id, {
    action: "reschedule",
    requestKey: "location-owner-move",
    version: moved.version,
    start: input.start + 8 * hour,
  });
  assert.equal(moved.location, address);
  assert.equal(moved.end - moved.start, initial.end - initial.start);
  const current = await f.db
    .prepare("SELECT confirmed_json FROM booking WHERE id=?")
    .bind(created.id)
    .first<string>("confirmed_json");
  assert.ok(current);
  const { start, end, privateMetadata, ...content } = snapshot(current);
  assert.deepEqual(content, (({ start, end, privateMetadata, ...rest }) => rest)(initial));
  assert.equal(privateMetadata.booking, initial.privateMetadata.booking);
  assert.equal(f.calendar.events.get(created.id)?.location, address);
  assert.equal((await client.view(access)).location, address);
  assert.equal((await owner.ownerView(created.id)).location, address);
  const ownerData = await (await f.request("/api/owner", { headers: f.ownerHeaders })).json();
  assert.equal(ownerData.bookings.find((row: BookingView) => row.id === created.id).location, address);
  const exports = calendarExport(moved, f.now());
  for (const href of [exports.google, exports.outlook, exports.office])
    assert.equal(new URL(href).searchParams.get("location"), address);
  const ics = decodeURIComponent(exports.ics).replace(/\r\n /g, "");
  assert.ok(ics.includes('LOCATION:Room-private-marker\\n東京 😀 <script>"&</script> Floor 2\r\n'));
  for (const value of Object.values(exports))
    assert.doesNotMatch(
      decodeURIComponent(value),
      /Private notes|Private cancellation|manageToken|guest@example/
    );
  for (const path of [
    "/api/public",
    "/api/owner",
    `/api/owner/bookings/${created.id}`,
    `/api/bookings/${created.id}`,
    "/api/slots?from=2030-01-02T00:00:00Z&to=2030-01-03T00:00:00Z&timeZone=UTC",
    "/api/slots?timeZone=invalid",
  ])
    assert.equal((await (await f.request(path)).text()).includes("Room-private-marker"), false);
  const wrong = await f.request(`/api/bookings/${created.id}`, {
    headers: { Authorization: `Bearer ${"x".repeat(43)}` },
  });
  assert.equal(wrong.status, 404);
  assert.equal((await wrong.text()).includes("Room-private-marker"), false);
  assert.equal((await f.send("/api/bookings", { ...input, location: "Attendee choice" })).status, 400);
  assert.equal(
    (
      await f.send(
        `/api/bookings/${created.id}`,
        {
          action: "cancel",
          requestKey: "location-injected-change",
          version: moved.version,
          location: "Attendee choice",
        },
        { Authorization: `Bearer ${access.token}` }
      )
    ).status,
    400
  );
  f.calendar.cutAfter = "delete";
  const cancelling = await owner.ownerCancel(created.id, {
    action: "cancel",
    requestKey: "location-owner-cancel",
    version: moved.version,
    cancellationReason: "Private cancellation",
  });
  assert.equal(cancelling.status, "attention");
  assert.equal(Object.hasOwn(cancelling, "location"), false);
  const cancelled = await client.retry(access);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellationReason, "Private cancellation");
  assert.equal(Object.hasOwn(cancelled, "location"), false);
  assert.equal(
    await f.db.prepare("SELECT initial_json FROM booking WHERE id=?").bind(created.id).first("initial_json"),
    stored.initial_json
  );
});

test("snapshot and client boundaries preserve canonical literal UTF-16 and legacy omission", async () => {
  const initial: BookingSnapshot = {
    id: "a".repeat(64),
    start: Date.UTC(2030, 0, 1),
    end: Date.UTC(2030, 0, 1, 0, 30),
    timeZone: "UTC",
    title: "Call",
    description: "",
    attendee: { name: "Guest", email: "guest@example.test" },
    privateMetadata: {},
  };
  const view: BookingView = {
    id: initial.id,
    start: initial.start,
    end: initial.end,
    timeZone: "UTC",
    title: "Call",
    name: "Guest",
    email: "guest@example.test",
    version: 1,
    status: "confirmed",
  };
  const access = { id: initial.id, token: "b".repeat(43) };
  assert.equal(JSON.stringify(snapshot(JSON.stringify(initial))), JSON.stringify(initial));
  const remote = {
    id: initial.id,
    etag: '"one"',
    start: { dateTime: new Date(initial.start).toISOString() },
    end: { dateTime: new Date(initial.end).toISOString() },
    summary: "Call",
    attendees: [{ email: initial.attendee.email, displayName: initial.attendee.name }],
    extendedProperties: { private: {} },
  };
  for (const location of [address, "x".repeat(1000), "😀".repeat(500), "A\ud800B", "A\udfffB", "A\u0000B"]) {
    const desired = { ...initial, location };
    assert.equal(snapshot(JSON.stringify(desired)).location, location);
    const client = new BookerClient(async () => Response.json({ ...view, location }));
    assert.equal((await client.view(access)).location, location);
    assert.equal((await client.ownerView(access.id)).location, location);
    assert.equal(matches({ ...remote, location }, desired), true);
    for (const actual of [undefined, "", "Changed", ` ${location}`]) {
      assert.equal(matches({ ...remote, location: actual }, desired), false);
      assert.equal(matches({ ...remote, location: actual }, initial), true);
    }
  }
  for (const location of [
    null,
    false,
    42,
    [],
    {},
    "",
    " \n",
    " padded ",
    "x".repeat(1001),
    `${"😀".repeat(500)}x`,
  ]) {
    assert.throws(() => snapshot(JSON.stringify({ ...initial, location })));
    await assert.rejects(
      new BookerClient(async () => Response.json({ ...view, location })).view(access),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
    );
  }
  for (const change of [
    { status: "pending", pendingAction: "create" },
    { status: "rescheduling", pendingAction: "reschedule" },
    { status: "cancelling", pendingAction: "cancel" },
    { status: "attention", pendingAction: "create", error: "event_mismatch" },
    { status: "cancelled" },
  ])
    await assert.rejects(
      new BookerClient(async () => Response.json({ ...view, ...change, location: address })).view(access),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
    );
  assert.throws(() =>
    parseChange({
      action: "reschedule",
      requestKey: "location-input-change",
      version: 1,
      start: initial.start,
      location: address,
    })
  );
});

test("lost insert and move responses recover only an exact frozen location without duplicate writes", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  await configure(f, address);
  for (const [index, drift] of [undefined, "Changed", ""].entries()) {
    const input = {
      requestKey: `location-lost-insert-${index}`,
      start: f.now() + (index + 1) * 12 * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    };
    f.calendar.cutAfter = "insert";
    const pending = await (await f.send("/api/bookings", input)).json();
    assert.equal(pending.status, "attention");
    assert.equal(Object.hasOwn(pending, "location"), false);
    const headers = { Authorization: `Bearer ${pending.manageToken}` };
    const event = f.calendar.events.get(pending.id);
    assert.ok(event);
    if (drift !== undefined) {
      if (drift) event.location = drift;
      else delete event.location;
    }
    const writes = f.calendar.writes.length;
    const recovered = await (await f.send(`/api/bookings/${pending.id}/retry`, {}, headers)).json();
    assert.equal(recovered.status, drift === undefined ? "confirmed" : "attention");
    assert.equal(f.calendar.writes.length, writes);
    if (drift !== undefined) {
      assert.equal(recovered.error, "event_mismatch");
      assert.equal(Object.hasOwn(recovered, "location"), false);
      assert.equal(
        await f.db
          .prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?")
          .bind(pending.id)
          .first("n"),
        1
      );
      continue;
    }
    assert.equal(recovered.location, address);
    await configure(f, "B");
    for (const [move, location] of [address, "Changed", undefined].entries()) {
      f.calendar.cutAfter = "update";
      const result = await (
        await f.send(
          `/api/bookings/${pending.id}`,
          {
            action: "reschedule",
            requestKey: `location-lost-move-${move}`,
            version: recovered.version + move,
            start: input.start + (move + 1) * hour,
          },
          headers
        )
      ).json();
      assert.equal(result.status, "attention");
      assert.equal(Object.hasOwn(result, "location"), false);
      const remote = f.calendar.events.get(pending.id);
      assert.ok(remote);
      if (location === undefined) delete remote.location;
      else remote.location = location;
      const before = f.calendar.writes.length;
      const retry = await (await f.send(`/api/bookings/${pending.id}/retry`, {}, headers)).json();
      assert.equal(retry.status, move === 0 ? "confirmed" : "attention");
      assert.equal(f.calendar.writes.length, before);
      if (move === 0) assert.equal(retry.location, address);
      else {
        assert.equal(retry.error, "event_changed");
        assert.equal(
          await f.db
            .prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?")
            .bind(pending.id)
            .first("n"),
          2
        );
        remote.location = address;
        assert.equal(
          (await (await f.send(`/api/bookings/${pending.id}/retry`, {}, headers)).json()).status,
          "confirmed"
        );
      }
    }
    await configure(f, address);
  }
});

test("external location drift blocks moves/cancellation and legacy provider locations survive moves", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  await configure(f, address);
  const update = f.calendar.update.bind(f.calendar);
  for (const [index, action] of ["reschedule", "cancel", "reschedule"].entries()) {
    const created = await (
      await f.send("/api/bookings", {
        requestKey: `location-drift-create-${index}`,
        start: f.now() + (index + 1) * 4 * hour,
        name: "Guest",
        email: "guest@example.test",
        timeZone: "UTC",
      })
    ).json();
    const remote = f.calendar.events.get(created.id);
    assert.ok(remote);
    if (index < 2) remote.location = "External edit";
    else
      f.calendar.update = (...args) => {
        remote.etag = '"external-race"';
        return update(...args);
      };
    const writes = f.calendar.writes.length;
    const changed = await (
      await f.send(
        `/api/bookings/${created.id}`,
        {
          action,
          requestKey: `location-drift-change-${index}`,
          version: created.version,
          ...(action === "reschedule" ? { start: f.now() + (20 + index) * hour } : {}),
        },
        { Authorization: `Bearer ${created.manageToken}` }
      )
    ).json();
    assert.equal(changed.error, index < 2 ? "event_changed" : "calendar_unresolved");
    assert.equal(Object.hasOwn(changed, "location"), false);
    assert.equal(f.calendar.writes.length, writes);
    if (index === 2) {
      const retried = await (
        await f.send(
          `/api/bookings/${created.id}/retry`,
          {},
          { Authorization: `Bearer ${created.manageToken}` }
        )
      ).json();
      assert.equal(retried.error, "event_changed");
      assert.equal(f.calendar.writes.length, writes);
    }
  }
  f.calendar.update = update;
  await configure(f);
  const legacy = await (
    await f.send("/api/bookings", {
      requestKey: "location-legacy-create",
      start: f.now() + 16 * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    })
  ).json();
  const remote = f.calendar.events.get(legacy.id);
  assert.ok(remote);
  remote.location = "Unknown historical provider location";
  const moved = await (
    await f.send(
      `/api/bookings/${legacy.id}`,
      {
        action: "reschedule",
        requestKey: "location-legacy-move",
        version: legacy.version,
        start: f.now() + 18 * hour,
      },
      { Authorization: `Bearer ${legacy.manageToken}` }
    )
  ).json();
  assert.equal(moved.status, "confirmed");
  assert.equal(Object.hasOwn(moved, "location"), false);
  assert.equal(f.calendar.events.get(legacy.id)?.location, "Unknown historical provider location");
});
