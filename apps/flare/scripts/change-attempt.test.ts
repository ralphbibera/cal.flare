import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { ChangeAttempts, type ChangeInput } from "../src/client/change-attempt.ts";
import { captureOwnerChange } from "../src/client/owner-change.ts";
import type { BookingView } from "../src/server/booking-model.ts";

function session() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  return { values, storage };
}
const bookingId = "a".repeat(64);
const hour = 3_600_000;
const input = { action: "reschedule", version: 1, start: Date.UTC(2030, 0, 1, 10) } as const;
const code = (expected: string) => (error: unknown) =>
  error instanceof ErrorWithCode && error.code === expected;
const ownerBooking: BookingView = {
  id: bookingId,
  status: "confirmed",
  version: 1,
  start: input.start,
  end: input.start + hour / 2,
  name: "Guest",
  email: "guest@example.test",
  timeZone: "UTC",
  title: "Original event",
};

test("owner capture gates fresh actions before storage and freezes canonical request bytes", (t) => {
  t.mock.method(Date, "now", () => ownerBooking.end);
  const tab = session(),
    store = new ChangeAttempts({ storage: tab.storage, bookingId });
  const context = {
    booking: ownerBooking,
    draft: "  Need to cancel\r\n<literal>  ",
    moveDraft: " \n\t ",
    attempts: () => store,
  };
  const cancel = captureOwnerChange({ ...context, command: { action: "cancel" } });
  assert.equal(cancel.kind, "ready");
  assert.ok(cancel.kind === "ready");
  assert.equal(
    JSON.stringify(cancel.request),
    `{"action":"cancel","requestKey":"${cancel.request.requestKey}","version":1,"cancellationReason":"Need to cancel\\r\\n<literal>"}`
  );
  assert.ok(Object.isFrozen(cancel.request));
  store.acknowledge(cancel.request.requestKey);
  const command = { action: "reschedule", start: input.start + hour } as const;
  const move = captureOwnerChange({ ...context, command });
  assert.ok(move.kind === "ready");
  assert.equal(
    JSON.stringify(move.request),
    `{"action":"reschedule","requestKey":"${move.request.requestKey}","version":1,"start":${command.start}}`
  );
  store.acknowledge(move.request.requestKey);
  for (const draft of ["", " \n\t ", "x".repeat(1001)])
    assert.deepEqual(captureOwnerChange({ ...context, draft, command: { action: "cancel" } }), {
      kind: "invalid-reason",
    });
  assert.deepEqual(captureOwnerChange({ ...context, command, moveDraft: "😀".repeat(501) }), {
    kind: "invalid-reason",
  });
  for (const booking of [
    { ...ownerBooking, disableCancelling: true, disableRescheduling: true },
    { ...ownerBooking, end: ownerBooking.end - 1 },
    { ...ownerBooking, status: "attention" } as const,
  ]) {
    for (const action of ["cancel", "reschedule"] as const)
      assert.deepEqual(
        captureOwnerChange({ ...context, booking, command: { ...command, action }, draft: "" }),
        { kind: "unavailable", action }
      );
  }
  assert.equal(tab.values.size, 0);
});

test("owner replay rereads durable canonical bytes independently of fresh policy and drafts", () => {
  const tab = session(),
    store = new ChangeAttempts({ storage: tab.storage, bookingId });
  const context = {
    booking: { ...ownerBooking, status: "cancelled", end: 0 } as const,
    draft: "",
    moveDraft: "x".repeat(1001),
    attempts: () => store,
  };
  for (const input of [
    { action: "cancel", version: 1, cancellationReason: "Required" } as const,
    { action: "reschedule", version: 1, start: ownerBooking.start + hour } as const,
  ]) {
    const frozen = store.begin(input),
      command = { request: frozen };
    const key = [...tab.values.keys()][0];
    assert.ok(key);
    assert.deepEqual(captureOwnerChange({ ...context, command }), { kind: "ready", request: frozen });
    for (const raw of [
      null,
      "{",
      JSON.stringify({ ...frozen, version: 2 }),
      JSON.stringify({ ...frozen, requestKey: crypto.randomUUID() }),
      JSON.stringify({ action: "cancel", requestKey: frozen.requestKey, version: 1 }),
      JSON.stringify({ ...frozen, start: ownerBooking.start + 2 * hour }),
    ]) {
      if (raw === null) tab.values.delete(key);
      else tab.values.set(key, raw);
      assert.deepEqual(captureOwnerChange({ ...context, command }), { kind: "storage-blocked" });
      assert.equal(tab.values.get(key) ?? null, raw);
    }
    tab.values.clear();
  }
});

test("owner capture fails closed on inaccessible storage without replacing pending requests", (t) => {
  t.mock.method(Date, "now", () => ownerBooking.end);
  const tab = session(),
    fail = () => {
      throw new Error("Storage denied");
    };
  const context = { booking: ownerBooking, draft: "Required", moveDraft: "" };
  for (const operation of ["getItem", "setItem"] as const) {
    const attempts = () => new ChangeAttempts({ bookingId, storage: { ...tab.storage, [operation]: fail } });
    assert.deepEqual(captureOwnerChange({ ...context, attempts, command: { action: "cancel" } }), {
      kind: "storage-blocked",
    });
    assert.equal(tab.values.size, 0);
  }
  const store = new ChangeAttempts({ bookingId, storage: tab.storage }),
    request = store.begin({ action: "cancel", version: 1, cancellationReason: "Required" });
  assert.deepEqual(captureOwnerChange({ ...context, attempts: fail, command: { request } }), {
    kind: "storage-blocked",
  });
  assert.deepEqual(store.read(), request);
});

test("owner rejection retires replay identity while uncertain failures keep the frozen command", (t) => {
  t.mock.method(Date, "now", () => ownerBooking.end);
  const tab = session(),
    store = new ChangeAttempts({ bookingId, storage: tab.storage });
  const context = { booking: ownerBooking, draft: "Required", moveDraft: "", attempts: () => store };
  const captured = captureOwnerChange({ ...context, command: { action: "cancel" } });
  assert.ok(captured.kind === "ready");
  const { request } = captured;
  assert.equal(store.reject(request.requestKey, new ErrorWithCode("network_error", 0)), false);
  assert.deepEqual(captureOwnerChange({ ...context, command: { request } }), captured);
  assert.equal(store.reject(request.requestKey, new ErrorWithCode("stale", 409)), true);
  assert.equal(store.read(), null);
  assert.deepEqual(captureOwnerChange({ ...context, command: { request } }), { kind: "storage-blocked" });
  const reconfirmed = captureOwnerChange({
    ...context,
    booking: { ...ownerBooking, version: 2 },
    command: { action: "cancel" },
  });
  assert.ok(reconfirmed.kind === "ready");
  assert.notEqual(reconfirmed.request.requestKey, request.requestKey);
  assert.equal(reconfirmed.request.version, 2);
});

test("management changes survive reload and fence different or stale operations", () => {
  const tab = session(),
    options = { storage: tab.storage, bookingId };
  const store = new ChangeAttempts(options),
    first = store.begin(input);
  assert.deepEqual(new ChangeAttempts(options).read(), first);
  assert.deepEqual(store.begin(input), first);
  assert.ok(Object.isFrozen(first));
  for (const changed of [
    { ...input, version: 2 },
    { ...input, start: input.start + hour },
    { action: "cancel", version: 1 } as const,
  ]) {
    assert.throws(() => store.begin(changed), code("booking_in_progress"));
    assert.deepEqual(store.read(), first);
  }
  assert.equal(store.acknowledge(crypto.randomUUID()), false);
  for (const [reason, status] of [
    ["network_error", 0],
    ["invalid_response", 200],
    ["failure", 408],
    ["failure", 429],
    ["failure", 503],
    ["idempotency_mismatch", 409],
    ["invalid_input", 400],
    ["not_found", 404],
  ] as const) {
    assert.equal(store.reject(first.requestKey, new ErrorWithCode(reason, status)), false);
    assert.deepEqual(store.read(), first);
  }
  const other = new ChangeAttempts({ storage: tab.storage, bookingId: "b".repeat(64) });
  const independent = other.begin({ action: "cancel", version: 7 });
  assert.equal(store.acknowledge(first.requestKey), true);
  assert.deepEqual(other.read(), independent);
  const next = store.begin({ action: "cancel", version: 2 });
  assert.notEqual(next.requestKey, first.requestKey);
  assert.equal(store.acknowledge(first.requestKey), false);
  assert.deepEqual(store.read(), next);
  for (const reason of ["conflict", "invalid_slot", "settings_changed", "stale", "busy", "invalid_state"]) {
    const pending = store.read() ?? store.begin({ action: "cancel", version: 2 });
    assert.equal(store.reject(pending.requestKey, new ErrorWithCode(reason, 409)), true);
    assert.equal(store.read(), null);
  }
});

test("invalid or inaccessible change storage cannot authorize a replacement", async () => {
  const tab = session(),
    options = { storage: tab.storage, bookingId },
    store = new ChangeAttempts(options);
  const fail = () => {
    throw new Error("private storage failure");
  };
  let posts = 0;
  const client = new BookerClient(async () => {
    posts++;
    throw new Error("unexpected POST");
  });
  for (const operation of ["getItem", "setItem"] as const) {
    const denied = new ChangeAttempts({ ...options, storage: { ...tab.storage, [operation]: fail } });
    assert.throws(() => denied.begin(input), code("storage_unavailable"));
    await assert.rejects(
      async () =>
        client.change(
          { id: bookingId, token: "b".repeat(43) },
          denied.begin({ action: "cancel", version: 1, cancellationReason: "Private reason" })
        ),
      code("storage_unavailable")
    );
    assert.equal(posts, 0);
    await assert.rejects(
      async () =>
        client.change(
          { id: bookingId, token: "b".repeat(43) },
          denied.begin({ ...input, rescheduleReason: "Private move" })
        ),
      code("storage_unavailable")
    );
    assert.equal(posts, 0);
    assert.equal(tab.values.size, 0);
  }
  const pending = store.begin(input),
    key = [...tab.values.keys()][0];
  assert.ok(key);
  const denied = new ChangeAttempts({ ...options, storage: { ...tab.storage, removeItem: fail } });
  assert.throws(() => denied.acknowledge(pending.requestKey), code("storage_unavailable"));
  assert.deepEqual(store.read(), pending);
  for (const raw of [
    "{",
    "null",
    "x".repeat(8193),
    JSON.stringify({ ...pending, requestKey: "bad" }),
    JSON.stringify({ ...pending, version: 0 }),
    JSON.stringify({ ...pending, version: 1.5 }),
    JSON.stringify({ ...pending, action: "create" }),
    JSON.stringify({ ...pending, start: 0 }),
    JSON.stringify({ ...pending, start: Date.UTC(2100, 0, 1) + 1 }),
    JSON.stringify({ ...pending, action: "cancel" }),
    JSON.stringify({ ...pending, cancellationReason: "" }),
  ]) {
    tab.values.set(key, raw);
    assert.throws(() => store.begin(input), code("invalid_saved_attempt"));
    assert.equal(tab.values.get(key), raw);
  }
  tab.values.clear();
  assert.throws(() => store.begin({ ...input, version: 0 }), code("invalid_input"));
  assert.equal(tab.values.size, 0);
  assert.throws(() => new ChangeAttempts({ ...options, bookingId: "wrong" }), code("invalid_access"));
});

test("saved cancellations retain normalized immutable reasons and bounded escaped content", () => {
  const tab = session(),
    options = { storage: tab.storage, bookingId },
    store = new ChangeAttempts(options);
  const cancel = { action: "cancel", version: 1 } satisfies ChangeInput;
  const legacy = store.begin(cancel);
  assert.equal(JSON.stringify(legacy), `{"action":"cancel","requestKey":"${legacy.requestKey}","version":1}`);
  assert.deepEqual(new ChangeAttempts(options).read(), legacy);
  for (const cancellationReason of ["", " \n\t "])
    assert.deepEqual(store.begin({ ...cancel, cancellationReason }), legacy);
  assert.equal(store.acknowledge(legacy.requestKey), true);
  const pending = store.begin({ ...cancel, cancellationReason: " \nNeed to cancel\t " });
  assert.deepEqual(pending, {
    ...cancel,
    requestKey: pending.requestKey,
    cancellationReason: "Need to cancel",
  });
  assert.ok(Object.isFrozen(pending));
  assert.deepEqual(
    new ChangeAttempts(options).begin({ ...cancel, cancellationReason: "Need to cancel" }),
    pending
  );
  assert.throws(() => store.begin({ ...cancel, cancellationReason: "Changed" }), code("booking_in_progress"));
  assert.deepEqual(store.read(), pending);
  const key = [...tab.values.keys()][0];
  assert.ok(key);
  for (const cancellationReason of [null, 1, [], {}, "x".repeat(1001), `${"😀".repeat(500)}x`]) {
    const raw = JSON.stringify({ ...pending, cancellationReason });
    tab.values.set(key, raw);
    assert.throws(() => store.read(), code("invalid_saved_attempt"));
    assert.equal(tab.values.get(key), raw);
  }
  tab.values.clear();
  for (const cancellationReason of ["\u0000".repeat(1000), "😀".repeat(500), "First\r\n\n é <literal>"]) {
    const saved = store.begin({ ...cancel, cancellationReason });
    assert.deepEqual(new ChangeAttempts(options).read(), saved);
    assert.equal(store.acknowledge(saved.requestKey), true);
  }
  const saved = store.begin(cancel),
    raw = tab.values.get(key);
  assert.ok(raw);
  tab.values.set(key, raw.padEnd(8192, " "));
  assert.deepEqual(store.read(), saved);
  tab.values.set(key, raw.padEnd(8193, " "));
  assert.throws(() => store.read(), code("invalid_saved_attempt"));
});

test("saved move and cancellation recover lost HTTP acknowledgments without duplicate Calendar writes", async (t) => {
  const { apiFixture } = await import("./fixtures/api.ts");
  const fixture = await apiFixture();
  t.after(fixture.close);
  let loseResponse = false;
  const bodies: string[] = [];
  const client = new BookerClient(async (path, init) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", fixture.env.PUBLIC_ORIGIN);
    const response = await fixture.request(path, { ...init, headers });
    if (init.method === "POST" && path !== "/api/bookings") bodies.push(String(init.body));
    if (loseResponse) {
      loseResponse = false;
      await response.arrayBuffer();
      throw new Error("Response lost");
    }
    return response;
  });
  let booking = await client.create({
    requestKey: crypto.randomUUID(),
    start: fixture.now() + 10 * hour,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  });
  const access = { id: booking.id, token: booking.manageToken },
    tab = session();
  const options = { storage: tab.storage, bookingId: booking.id };
  for (const action of ["reschedule", "cancel"] as const) {
    const store = new ChangeAttempts(options);
    const pending = store.begin(
      action === "reschedule"
        ? {
            action,
            version: booking.version,
            start: fixture.now() + 12 * hour,
            rescheduleReason: " \nNeed to move\t ",
          }
        : { action, version: booking.version, cancellationReason: " \nNeed to cancel\t " }
    );
    loseResponse = true;
    await assert.rejects(client.change(access, pending), code("network_error"));
    const reloaded = new ChangeAttempts(options),
      saved = reloaded.read();
    assert.deepEqual(saved, pending);
    assert.ok(saved);
    const result = await client.change(access, saved);
    assert.equal(result.status, action === "cancel" ? "cancelled" : "confirmed");
    assert.equal(result.cancellationReason, action === "cancel" ? "Need to cancel" : undefined);
    assert.equal(result.rescheduleReason, action === "reschedule" ? "Need to move" : undefined);
    assert.equal(result.start, fixture.now() + 12 * hour);
    assert.equal(reloaded.acknowledge(saved.requestKey), true);
    assert.equal(reloaded.read(), null);
    assert.deepEqual(bodies.at(-1), bodies.at(-2));
    booking = { ...result, manageToken: access.token };
  }
  assert.deepEqual(
    fixture.calendar.writes.map((write) => write.action),
    ["insert", "update", "delete"]
  );
  assert.equal(fixture.calendar.events.size, 0);
  assert.equal(await fixture.db.prepare("SELECT count(*) FROM booking_command").first("count(*)"), 3);
});

test("saved moves freeze normalized reasons, restore legacy bytes and fail closed on invalid reasons", () => {
  const tab = session(),
    options = { storage: tab.storage, bookingId },
    store = new ChangeAttempts(options);
  const legacy = store.begin(input);
  assert.equal(
    JSON.stringify(legacy),
    `{"action":"reschedule","requestKey":"${legacy.requestKey}","version":1,"start":${input.start}}`
  );
  assert.deepEqual(new ChangeAttempts(options).read(), legacy);
  for (const rescheduleReason of ["", " \n\t "])
    assert.deepEqual(store.begin({ ...input, rescheduleReason }), legacy);
  store.acknowledge(legacy.requestKey);
  const pending = store.begin({ ...input, rescheduleReason: " \nNeed to move\t " });
  assert.equal(pending.action === "reschedule" && pending.rescheduleReason, "Need to move");
  assert.ok(Object.isFrozen(pending));
  assert.deepEqual(
    new ChangeAttempts(options).begin({ ...input, rescheduleReason: "Need to move" }),
    pending
  );
  assert.throws(() => store.begin({ ...input, rescheduleReason: "Changed" }), code("booking_in_progress"));
  assert.deepEqual(store.read(), pending);
  const key = [...tab.values.keys()][0];
  assert.ok(key);
  for (const rescheduleReason of [null, 1, false, [], {}, "x".repeat(1001), `${"😀".repeat(500)}x`]) {
    const raw = JSON.stringify({ ...pending, rescheduleReason });
    tab.values.set(key, raw);
    assert.throws(() => store.begin(input), code("invalid_saved_attempt"));
    assert.equal(tab.values.get(key), raw);
  }
  tab.values.clear();
  for (const rescheduleReason of ["\u0000".repeat(1000), "😀".repeat(500), "First\r\n\n é <literal>"]) {
    const saved = store.begin({ ...input, version: Number.MAX_SAFE_INTEGER, rescheduleReason });
    assert.ok((tab.values.get(key)?.length ?? Infinity) <= 8192);
    assert.deepEqual(new ChangeAttempts(options).read(), saved);
    assert.equal(store.acknowledge(saved.requestKey), true);
    assert.equal(store.read(), null);
  }
  tab.values.set(
    key,
    JSON.stringify({ action: "cancel", requestKey: pending.requestKey, version: 1, rescheduleReason: "" })
  );
  assert.throws(() => store.read(), code("invalid_saved_attempt"));
});
