import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { ChangeAttempts, type ChangeInput } from "../src/client/change-attempt.ts";
import { apiFixture, hour } from "./fixtures/api.ts";

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
const input = { action: "reschedule", version: 1, start: Date.UTC(2030, 0, 1, 10) } as const;
const code = (expected: string) => (error: unknown) =>
  error instanceof ErrorWithCode && error.code === expected;

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
  const fixture = await apiFixture();
  t.after(fixture.close);
  let loseResponse = false;
  const bodies: unknown[] = [];
  const client = new BookerClient(async (path, init) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", fixture.env.PUBLIC_ORIGIN);
    const response = await fixture.request(path, { ...init, headers });
    if (init.method === "POST" && path !== "/api/bookings") bodies.push(JSON.parse(String(init.body)));
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
        ? { action, version: booking.version, start: fixture.now() + 12 * hour }
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
