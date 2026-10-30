import assert from "node:assert/strict";
import { test } from "node:test";
import { availableSlots } from "../src/domain/scheduling.ts";
import { defaultSettings, parseBookingRules, parseSettings, SettingsError } from "../src/domain/settings.ts";
import { snapshot } from "../src/server/booking-model.ts";
import { BookingService } from "../src/server/bookings.ts";
import { getSettings } from "../src/server/settings.ts";
import { apiFixture, hour, settings, storedSettings } from "./fixtures/api.ts";

const rules = {
  intervalMinutes: 30,
  beforeMinutes: 0,
  afterMinutes: 0,
  noticeMinutes: 0,
  disableCancelling: false,
  disableRescheduling: false,
};
const day = 24 * hour;

test("existing-booking listings and both move actors use the stored window zone independently of query zone", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const listings: unknown[] = [],
    expected: unknown[] = [];
  let sequence = 0;
  for (const [bookingWindowDays, finalStart] of [
    [1, "2030-01-02T09:00:00Z"],
    [30, "2030-01-31T09:00:00Z"],
    [undefined, "2030-02-02T09:00:00Z"],
  ] as const) {
    for (const storedZone of bookingWindowDays === undefined ? ["UTC"] : ["America/Los_Angeles", "UTC"]) {
      assert.equal(
        (
          await f.send(
            "/api/owner",
            { ...settings, event: { ...settings.event, location: "Original room" } },
            f.ownerHeaders,
            "PUT"
          )
        ).status,
        200
      );
      const response = await f.send("/api/bookings", {
        requestKey: `window-zone-create-${++sequence}`,
        start: f.now() + sequence * hour,
        name: "Historical guest",
        email: "guest@example.test",
        timeZone: storedZone,
        notes: "Keep historical facts",
      });
      assert.equal(response.status, 201);
      const created = await response.json();
      const stored = async () => {
        const json = await f.db
          .prepare("SELECT confirmed_json FROM booking WHERE id=?")
          .bind(created.id)
          .first<string>("confirmed_json");
        assert.ok(json);
        return snapshot(json);
      };
      const original = await stored();
      assert.equal(
        (
          await f.send(
            "/api/owner",
            {
              ...settings,
              event: {
                ...settings.event,
                ...rules,
                title: "Changed title",
                durationMinutes: 90,
                ...(bookingWindowDays === undefined ? {} : { bookingWindowDays }),
              },
            },
            f.ownerHeaders,
            "PUT"
          )
        ).status,
        200
      );
      const allowed = storedZone === "UTC";
      const start = Date.parse(finalStart);
      const query = new URLSearchParams({
        from: new Date(start).toISOString(),
        to: new Date(start + hour).toISOString(),
        timeZone: allowed ? "America/Los_Angeles" : "UTC",
      });
      let version = 1;
      for (const [path, headers, slotsPath] of [
        [`/api/owner/bookings/${created.id}`, f.ownerHeaders, `/api/owner/bookings/${created.id}/slots`],
        [
          `/api/bookings/${created.id}`,
          { Authorization: `Bearer ${created.manageToken}` },
          `/api/slots?bookingId=${created.id}`,
        ],
      ] as const) {
        const listed = await f.request(`${slotsPath}${slotsPath.includes("?") ? "&" : "?"}${query}`, {
          headers,
        });
        assert.equal(listed.status, 200);
        listings.push({ bookingWindowDays, storedZone, path, slots: (await listed.json()).slots });
        expected.push({
          bookingWindowDays,
          storedZone,
          path,
          slots: allowed
            ? [
                { start, end: start + hour / 2 },
                { start: start + hour / 2, end: start + hour },
              ]
            : [],
        });
        const target = start + (version - 1) * (hour / 2);
        const moved = await f.send(
          path,
          { action: "reschedule", requestKey: crypto.randomUUID(), version, start: target },
          headers
        );
        assert.equal(moved.status, allowed ? 200 : 409);
        if (!allowed) {
          assert.equal((await moved.json()).error, "invalid_slot");
          assert.deepEqual(await stored(), original);
          continue;
        }
        const result = await moved.json();
        assert.equal(result.version, ++version);
        assert.equal(result.id, created.id);
        const current = await stored();
        assert.deepEqual(current, {
          ...original,
          start: target,
          end: target + hour / 2,
          privateMetadata: current.privateMetadata,
        });
      }
      if (allowed) {
        query.set("timeZone", "Asia/Kathmandu");
        for (const [path, headers, slotsPath] of [
          [`/api/owner/bookings/${created.id}`, f.ownerHeaders, `/api/owner/bookings/${created.id}/slots`],
          [
            `/api/bookings/${created.id}`,
            { Authorization: `Bearer ${created.manageToken}` },
            `/api/slots?bookingId=${created.id}`,
          ],
        ] as const) {
          const rounded = await f.request(`${slotsPath}${slotsPath.includes("?") ? "&" : "?"}${query}`, {
            headers,
          });
          assert.equal(rounded.status, 200);
          const { slots } = await rounded.json();
          const target = Date.parse(query.get("from") ?? "") + hour / 4;
          assert.deepEqual(slots, [{ start: target, end: target + hour / 2 }]);
          const moved = await f.send(
            path,
            { action: "reschedule", requestKey: crypto.randomUUID(), version, start: slots[0].start },
            headers
          );
          assert.equal(
            moved.status,
            200,
            `Exact listed Kathmandu start is submittable with window ${bookingWindowDays}`
          );
          const result = await moved.json();
          assert.equal(result.version, ++version);
          assert.equal(result.id, created.id);
          const current = await stored();
          assert.deepEqual(current, {
            ...original,
            start: target,
            end: target + hour / 2,
            privateMetadata: current.privateMetadata,
          });
          query.set("from", new Date(start + hour).toISOString());
          query.set("to", new Date(start + 2 * hour).toISOString());
        }
      }
    }
  }
  assert.deepEqual(listings, expected);
});

test("window timezone leaves fractional-offset visitor rounding intact and rejects invalid internal zones", () => {
  const input = {
    schedule: settings.schedule,
    policy: { ...rules, durationMinutes: 30, intervalMinutes: 60, bookingWindowDays: 1 },
    visitorTimeZone: "Asia/Kathmandu",
    windowTimeZone: "UTC",
    now: Date.parse("2030-01-01T00:00:00Z"),
    from: Date.parse("2030-01-01T09:00:00Z"),
    to: Date.parse("2030-01-01T11:00:00Z"),
    busy: [],
  };
  assert.deepEqual(availableSlots(input), [
    { start: Date.parse("2030-01-01T09:15:00Z"), end: Date.parse("2030-01-01T09:45:00Z") },
    { start: Date.parse("2030-01-01T10:15:00Z"), end: Date.parse("2030-01-01T10:45:00Z") },
  ]);
  for (const windowTimeZone of ["", "+05:45", "Invalid/Zone"])
    assert.throws(() => availableSlots({ ...input, windowTimeZone }), RangeError);
});

test("exact-start moves retain schedule, notice, window, occupancy and minute-alignment restrictions", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const configured = { ...settings, event: { ...settings.event, ...rules } };
  assert.equal((await f.send("/api/owner", configured, f.ownerHeaders, "PUT")).status, 200);
  const created = await (
    await f.send("/api/bookings", {
      requestKey: crypto.randomUUID(),
      start: f.now() + hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    })
  ).json();
  const target = f.now() + 2 * day + 9 * hour + hour / 4;
  const offGridCreate = await f.send("/api/bookings", {
    requestKey: crypto.randomUUID(),
    start: target,
    name: "Fresh guest",
    email: "fresh@example.test",
    timeZone: "UTC",
  });
  assert.equal(offGridCreate.status, 409);
  assert.equal((await offGridCreate.json()).error, "invalid_slot");
  assert.equal(
    (
      await f.send("/api/bookings", {
        requestKey: crypto.randomUUID(),
        start: target + hour / 4,
        name: "Other",
        email: "other@example.test",
        timeZone: "UTC",
      })
    ).status,
    201
  );
  const original = await f.db.prepare("SELECT * FROM booking WHERE id=?").bind(created.id).first();
  const writes = f.calendar.writes.length;
  for (const [name, policy, schedule, start, error] of [
    [
      "hours",
      {},
      { ...settings.schedule, rules: [{ weekday: 4, startMinute: 600, endMinute: 660 }] },
      target,
      "invalid_slot",
    ],
    [
      "override",
      {},
      { ...settings.schedule, overrides: [{ date: "2030-01-03", ranges: [] }] },
      target,
      "invalid_slot",
    ],
    ["notice", { noticeMinutes: 4 * 1440 }, settings.schedule, target, "invalid_slot"],
    ["window", { bookingWindowDays: 1 }, settings.schedule, target, "invalid_slot"],
    ["remote", {}, settings.schedule, target + day, "conflict"],
    ["local", {}, settings.schedule, target, "conflict"],
    ["seconds", {}, settings.schedule, target + 1000, "invalid_slot"],
    ["milliseconds", {}, settings.schedule, target + 1, "invalid_slot"],
    ["fractional timestamp", {}, settings.schedule, target + 0.5, "invalid_input"],
  ] as const) {
    assert.equal(
      (
        await f.send(
          "/api/owner",
          { ...configured, event: { ...configured.event, ...policy }, schedule },
          f.ownerHeaders,
          "PUT"
        )
      ).status,
      200
    );
    f.calendar.busy = async () => (name === "remote" ? [{ start, end: start + hour / 2 }] : []);
    for (const [path, headers] of [
      [`/api/owner/bookings/${created.id}`, f.ownerHeaders],
      [`/api/bookings/${created.id}`, { Authorization: `Bearer ${created.manageToken}` }],
    ] as const) {
      const response = await f.send(
        path,
        { action: "reschedule", requestKey: crypto.randomUUID(), version: 1, start },
        headers
      );
      assert.equal(response.status, error === "invalid_input" ? 400 : 409, name);
      assert.equal((await response.json()).error, error, name);
    }
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM booking WHERE id=?").bind(created.id).first(),
      original,
      name
    );
    assert.equal(f.calendar.writes.length, writes, name);
  }
});

test("rolling windows parse strictly without changing legacy settings or PATCH presence", () => {
  assert.equal(JSON.stringify(parseSettings(defaultSettings)), JSON.stringify(defaultSettings));
  assert.deepEqual(parseBookingRules(rules), rules);
  assert.deepEqual(parseBookingRules({ ...rules, bookingWindowDays: null }), {
    ...rules,
    bookingWindowDays: null,
  });
  for (const bookingWindowDays of [1, 30, 365]) {
    assert.equal(
      parseSettings({ ...settings, event: { ...settings.event, bookingWindowDays } }).event.bookingWindowDays,
      bookingWindowDays
    );
    assert.equal(parseBookingRules({ ...rules, bookingWindowDays }).bookingWindowDays, bookingWindowDays);
  }
  for (const bookingWindowDays of [undefined, null, 0, 366, 1.5, "30", true, {}, []]) {
    assert.throws(
      () => parseSettings({ ...settings, event: { ...settings.event, bookingWindowDays } }),
      SettingsError
    );
    if (bookingWindowDays !== null)
      assert.throws(() => parseBookingRules({ ...rules, bookingWindowDays }), SettingsError);
  }
});

test("listing and fresh creation or moves share the booker-local window and reject stale slots", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const save = (bookingWindowDays: number | null) =>
    f.send("/api/owner/booking-rules", { ...rules, bookingWindowDays }, f.ownerHeaders, "PATCH");
  const from = Date.parse("2030-01-31T23:30:00Z"),
    to = from + 2 * hour;
  const query = new URLSearchParams({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    timeZone: "UTC",
  });
  const cached = await (await f.request(`/api/slots?${query}`)).json();
  assert.ok(cached.slots.some((slot: { start: number }) => slot.start === from + hour));
  assert.equal((await save(30)).status, 200);
  const input = {
    requestKey: "window-final-create",
    start: from,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
    notes: "Keep facts",
  };
  const createdResponse = await f.send("/api/bookings", input);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const original = await f.db
    .prepare("SELECT confirmed_json FROM booking WHERE id=?")
    .bind(created.id)
    .first<string>("confirmed_json");
  assert.ok(original);
  const attendee = { Authorization: `Bearer ${created.manageToken}` };
  const ownerPath = `/api/owner/bookings/${created.id}`;
  const paths = [
    ["/api/slots", {}],
    [`/api/slots`, attendee],
    [`${ownerPath}/slots`, f.ownerHeaders],
  ] as const;
  for (const [path, headers] of paths) {
    const params = new URLSearchParams(query);
    if (headers === attendee) params.set("bookingId", created.id);
    const response = await f.request(`${path}?${params}`, { headers });
    assert.equal(response.status, 200);
    const slots = (await response.json()).slots;
    assert.equal(slots.length, path === "/api/slots" && headers !== attendee ? 0 : 1);
    assert.ok(slots.every((slot: { start: number }) => slot.start < Date.parse("2030-02-01T00:00:00Z")));
  }
  const stale = { ...input, requestKey: "window-stale-create", start: from + hour };
  assert.equal((await f.send("/api/bookings", stale)).status, 409);
  const rejected = await f.db
    .prepare("SELECT * FROM booking_command WHERE request_key=?")
    .bind(stale.requestKey)
    .first();
  for (const [path, headers] of [
    [`/api/bookings/${created.id}`, attendee],
    [ownerPath, f.ownerHeaders],
  ] as const) {
    const invalid = await f.send(
      path,
      { action: "reschedule", requestKey: crypto.randomUUID(), version: 1, start: from + hour },
      headers
    );
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json()).error, "invalid_slot");
  }
  const outside = new URLSearchParams({
    ...Object.fromEntries(query),
    from: "2030-02-02T00:00:00Z",
    to: "2030-02-03T00:00:00Z",
  });
  assert.deepEqual(await (await f.request(`/api/slots?${outside}`)).json(), { slots: [] });
  const tokyo = new URLSearchParams({
    ...Object.fromEntries(outside),
    from: "2030-01-31T15:00:00Z",
    to: "2030-01-31T16:00:00Z",
    timeZone: "Asia/Tokyo",
  });
  assert.deepEqual(await (await f.request(`/api/slots?${tokyo}`)).json(), { slots: [] });
  const eastern = {
    ...input,
    requestKey: "window-tokyo-create",
    start: Date.parse("2030-01-31T15:00:00Z"),
    timeZone: "Asia/Tokyo",
  };
  assert.equal((await f.send("/api/bookings", eastern)).status, 409);
  const western = {
    ...input,
    requestKey: "window-la-create",
    start: Date.parse("2030-01-31T07:30:00Z"),
    timeZone: "America/Los_Angeles",
  };
  const westernResponse = await f.send("/api/bookings", western);
  assert.equal(westernResponse.status, 201);
  const westernBooking = await westernResponse.json();
  for (const [path, headers] of [
    [`/api/bookings/${westernBooking.id}`, { Authorization: `Bearer ${westernBooking.manageToken}` }],
    [`/api/owner/bookings/${westernBooking.id}`, f.ownerHeaders],
  ] as const)
    assert.equal(
      (
        await f.send(
          path,
          {
            action: "reschedule",
            requestKey: crypto.randomUUID(),
            version: 1,
            start: Date.parse("2030-01-31T08:00:00Z"),
          },
          headers
        )
      ).status,
      409
    );
  assert.equal((await save(1)).status, 200);
  assert.equal((await f.send("/api/bookings", input)).status, 201, "accepted replay precedes current window");
  assert.equal((await save(null)).status, 200);
  assert.equal((await f.send("/api/bookings", stale)).status, 409);
  assert.deepEqual(
    await f.db.prepare("SELECT * FROM booking_command WHERE request_key=?").bind(stale.requestKey).first(),
    rejected
  );
  const hard = new URLSearchParams({
    from: new Date(f.now() + 365 * day).toISOString(),
    to: new Date(f.now() + 365 * day + hour).toISOString(),
    timeZone: "UTC",
  });
  assert.equal((await f.request(`/api/slots?${hard}`)).status, 400);
  assert.equal(
    (
      await f.send("/api/bookings", {
        ...stale,
        requestKey: "window-hard-ceiling",
        start: f.now() + 365 * day,
      })
    ).status,
    409
  );
  await f.send(
    "/api/owner",
    { ...settings, event: { ...settings.event, durationMinutes: 90, title: "Changed" } },
    f.ownerHeaders,
    "PUT"
  );
  let version = 1;
  for (const [path, headers] of [
    [`/api/bookings/${created.id}`, attendee],
    [ownerPath, f.ownerHeaders],
  ] as const) {
    const start = from + ++version * hour;
    const response = await f.send(
      path,
      { action: "reschedule", requestKey: crypto.randomUUID(), version: version - 1, start },
      headers
    );
    assert.equal(response.status, 200);
    const moved = await response.json();
    assert.equal(moved.id, created.id);
    assert.equal(moved.title, settings.event.title);
    assert.equal(moved.end - moved.start, hour / 2);
    const stored = snapshot(original);
    const current = snapshot(
      (await f.db
        .prepare("SELECT confirmed_json FROM booking WHERE id=?")
        .bind(created.id)
        .first<string>("confirmed_json")) ?? ""
    );
    assert.deepEqual(current, {
      ...stored,
      start,
      end: start + hour / 2,
      privateMetadata: current.privateMetadata,
    });
  }
});

test("queued and sent accepted commands recover with frozen settings after window tightening", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const configured = { ...settings, event: { ...settings.event, ...rules, bookingWindowDays: 30 } };
  const tightened = {
    ...configured,
    event: { ...configured.event, bookingWindowDays: 1, noticeMinutes: 43200, disableRescheduling: true },
    schedule: { ...settings.schedule, rules: [] },
  };
  const service = async () =>
    new BookingService({
      db: f.db,
      calendar: f.calendar,
      settings: await getSettings(f.db),
      secret: f.env.TOKEN_ENCRYPTION_KEY,
      now: f.now,
    });
  for (const mode of ["queued", "sent"] as const) {
    await f.send("/api/owner", configured, f.ownerHeaders, "PUT");
    let checks = 0;
    const busy = f.calendar.busy.bind(f.calendar);
    f.calendar.busy = async (...args) => {
      if (mode === "queued" && ++checks === 2) throw new Error("Fixture delivery read unavailable");
      return busy(...args);
    };
    if (mode === "sent") f.calendar.cutAfter = "insert";
    const input = {
      requestKey: `window-recover-${mode}`,
      start: f.now() + (mode === "queued" ? 10 : 12) * day,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    };
    const accepted = await (await f.send("/api/bookings", input)).json();
    assert.equal(accepted.status, "attention");
    f.calendar.busy = busy;
    const command = await f.db
      .prepare("SELECT execution,settings_json FROM booking_command WHERE request_key=?")
      .bind(input.requestKey)
      .first<{ execution: string; settings_json: string }>();
    assert.equal(command?.execution, mode);
    assert.equal(JSON.parse(command?.settings_json ?? "{}").event.bookingWindowDays, 30);
    await f.send("/api/owner", tightened, f.ownerHeaders, "PUT");
    const writes = f.calendar.writes.length;
    const recovered = await (await service()).create(input);
    assert.equal(recovered.status, "confirmed");
    assert.equal(recovered.id, accepted.id);
    assert.equal(f.calendar.writes.length, writes + (mode === "queued" ? 1 : 0));
    await f.send("/api/owner", configured, f.ownerHeaders, "PUT");
    const move = {
      action: "reschedule",
      requestKey: `window-move-${mode}`,
      version: 1,
      start: input.start + hour + hour / 4,
    };
    checks = 0;
    f.calendar.busy = async (...args) => {
      if (mode === "queued" && ++checks === 2) throw new Error("Fixture move delivery read unavailable");
      return busy(...args);
    };
    if (mode === "sent") f.calendar.cutAfter = "update";
    const moving = await (await service()).ownerChange(accepted.id, move);
    assert.equal(moving.status, "attention");
    assert.equal(
      await f.db
        .prepare("SELECT execution FROM booking_command WHERE request_key=?")
        .bind(move.requestKey)
        .first("execution"),
      mode
    );
    f.calendar.busy = busy;
    await f.send("/api/owner", tightened, f.ownerHeaders, "PUT");
    const moveWrites = f.calendar.writes.length;
    const moved = await (await service()).ownerRetry(accepted.id);
    assert.equal(moved.status, "confirmed");
    assert.equal(moved.start, move.start);
    assert.equal(f.calendar.writes.length, moveWrites + (mode === "queued" ? 1 : 0));
    assert.deepEqual(await (await service()).change(accepted.id, String(accepted.manageToken), move), moved);
    assert.equal(
      await f.db
        .prepare("SELECT count(*) FROM booking_command WHERE booking_id=? AND outcome='accepted'")
        .bind(accepted.id)
        .first("count(*)"),
      2
    );
  }
  assert.equal(f.calendar.events.size, 2);
  assert.equal(f.calendar.writes.length, 4);
});

test("rolling calendar dates include the final booker-local day by start across DST and rollover", () => {
  for (const [now, zone, days, last, next] of [
    ["2030-01-01T00:00:00Z", "UTC", 30, "2030-01-31T23:30:00Z", "2030-02-01T00:00:00Z"],
    ["2030-12-31T23:50:00Z", "Asia/Tokyo", 1, "2031-01-02T14:30:00Z", "2031-01-02T15:00:00Z"],
    ["2030-01-01T00:10:00Z", "America/Los_Angeles", 1, "2030-01-02T07:30:00Z", "2030-01-02T08:00:00Z"],
    ["2030-03-09T17:00:00Z", "America/New_York", 1, "2030-03-11T03:30:00Z", "2030-03-11T04:00:00Z"],
    ["2030-11-02T16:00:00Z", "America/New_York", 1, "2030-11-04T04:30:00Z", "2030-11-04T05:00:00Z"],
    ["2032-02-28T12:00:00Z", "UTC", 1, "2032-02-29T23:30:00Z", "2032-03-01T00:00:00Z"],
  ] as const) {
    const input = {
      schedule: settings.schedule,
      policy: { ...rules, durationMinutes: 60, bookingWindowDays: days },
      visitorTimeZone: zone,
      now: Date.parse(now),
      from: Date.parse(last),
      to: Date.parse(next) + hour,
      busy: [],
    };
    assert.deepEqual(
      availableSlots(input),
      [{ start: Date.parse(last), end: Date.parse(last) + hour }],
      `${zone} ${now}`
    );
    const { bookingWindowDays: _, ...unlimited } = input.policy;
    assert.equal(availableSlots({ ...input, policy: unlimited }).length, 2);
  }
});

test("rolling window partial writes preserve canonical bytes, independent fields and actual admission", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const raw = () => storedSettings(f.db);
  const patch = async (path: string, value: unknown) => {
    const before = await raw();
    assert.equal((await f.send(path, value, f.ownerHeaders, "PATCH")).status, 200);
    assert.equal((await raw())?.version, (before?.version ?? 0) + 1);
    assert.equal((await raw())?.json, JSON.stringify(await getSettings(f.db)));
  };
  const details = { slug: "intro", title: "Historical", description: "Literal\ud800", durationMinutes: 30 };
  let command = 0;
  for (const location of [undefined, "A\ud800B\u0000C 東京"])
    for (const policies of [
      {},
      { disableCancelling: true },
      { disableRescheduling: false },
      { disableRescheduling: true, disableCancelling: false },
    ]) {
      const event = { ...settings.event, ...policies, ...(location === undefined ? {} : { location }) };
      assert.equal((await f.send("/api/owner", { ...settings, event }, f.ownerHeaders, "PUT")).status, 200);
      for (const bookingWindowDays of [30, undefined, null, 1, 365]) {
        await patch("/api/owner/booking-rules", {
          ...rules,
          ...(bookingWindowDays === undefined ? {} : { bookingWindowDays }),
        });
        if (bookingWindowDays !== undefined)
          assert.equal((await getSettings(f.db)).event.bookingWindowDays, bookingWindowDays ?? undefined);
        await patch("/api/owner", { ...details, location: "Room\udfff\u0000" });
        await patch("/api/owner", { ...details, location: "" });
        await patch("/api/owner", { ...details, ...(location === undefined ? {} : { location }) });
        const version = (await raw())?.version ?? 0;
        const current = await getSettings(f.db);
        for (const response of await Promise.all([
          f.send("/api/owner/booking-rules", rules, f.ownerHeaders, "PATCH"),
          f.send(
            "/api/owner/schedule",
            { timeZone: "UTC", rules: settings.schedule.rules },
            f.ownerHeaders,
            "PATCH"
          ),
          f.send(
            "/api/owner/overrides",
            { overrides: [{ date: "2030-02-05", ranges: [] }] },
            f.ownerHeaders,
            "PATCH"
          ),
          f.send("/api/owner", details, f.ownerHeaders, "PATCH"),
        ]))
          assert.equal(response.status, 200);
        assert.equal((await raw())?.version, version + 4);
        assert.equal((await raw())?.json, JSON.stringify(await getSettings(f.db)));
        assert.equal((await getSettings(f.db)).event.bookingWindowDays, current.event.bookingWindowDays);
        assert.equal((await getSettings(f.db)).event.location, current.event.location);
        const created = await f.send(
          "/api/bookings",
          {
            requestKey: `window-canonical-${++command}`,
            start: f.now() + command * hour,
            timeZone: "UTC",
            name: "Guest",
            email: "guest@example.test",
          },
          { "CF-Connecting-IP": `192.0.2.${command}` }
        );
        assert.equal(created.status, 201, await created.text());
      }
    }
  const before = await raw();
  for (const value of [0, 366, 1.5, "30", true, {}])
    assert.equal(
      (
        await f.send(
          "/api/owner/booking-rules",
          { ...rules, bookingWindowDays: value },
          f.ownerHeaders,
          "PATCH"
        )
      ).status,
      400
    );
  for (const headers of [{}, { ...f.ownerHeaders, Origin: "https://foreign.test" }])
    assert.ok(
      [401, 403].includes(
        (await f.send("/api/owner/booking-rules", { ...rules, bookingWindowDays: 1 }, headers, "PATCH"))
          .status
      )
    );
  assert.deepEqual(await raw(), before);
  await patch("/api/owner/booking-rules", { ...rules, bookingWindowDays: 30 });
  assert.equal((await f.send("/api/owner", settings, f.ownerHeaders, "PUT")).status, 200);
  assert.equal(Object.hasOwn((await getSettings(f.db)).event, "bookingWindowDays"), false);
  for (const bookingWindowDays of [30, null, undefined]) {
    assert.equal((await f.send("/api/owner", settings, f.ownerHeaders, "PUT")).status, 200);
    await f.db.prepare("DELETE FROM organizer_settings").run();
    const unchanged = await f.db.prepare("SELECT * FROM event_type").all();
    assert.equal(
      (
        await f.send(
          "/api/owner/booking-rules",
          {
            ...rules,
            ...(bookingWindowDays === undefined ? {} : { bookingWindowDays }),
          },
          f.ownerHeaders,
          "PATCH"
        )
      ).status,
      400
    );
    assert.deepEqual((await f.db.prepare("SELECT * FROM event_type").all()).results, unchanged.results);
    assert.equal(await raw(), null);
    await f.db
      .prepare("INSERT INTO organizer_settings VALUES ('owner',?,1)")
      .bind(JSON.stringify({ schedule: settings.schedule }))
      .run();
  }
});
