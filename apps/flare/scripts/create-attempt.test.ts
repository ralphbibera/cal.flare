import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { CreateAttempts } from "../src/client/create-attempt.ts";

const hour = 3_600_000;

function session() {
  const values = new Map<string, string>();
  let failWrites = false;
  return {
    values,
    fail: () => {
      failWrites = true;
    },
    resume: () => {
      failWrites = false;
    },
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error("storage full");
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}
const body = { start: Date.UTC(2030, 0, 1, 10), name: "Guest", email: "guest@example.test", timeZone: "UTC" };
const access = { id: "a".repeat(64), token: "b".repeat(43) };

test("event attempts follow stable identity across rename and never cross events", () => {
  const tab = session();
  const a = new CreateAttempts({ storage: tab.storage, eventId: "default", scope: "/intro" });
  const first = a.begin(body);
  const renamed = new CreateAttempts({ storage: tab.storage, eventId: "default", scope: "/renamed" });
  assert.deepEqual(renamed.read(), first);
  const b = new CreateAttempts({
    storage: tab.storage,
    eventId: "11111111-1111-4111-8111-111111111111",
    scope: "/intro",
  });
  assert.equal(b.read(), null);
  assert.notEqual(b.begin(body).request.requestKey, first.request.requestKey);
  assert.equal(first.eventId, "default");
});

test("only the current default pathname imports v1, durably before consuming it", () => {
  for (const receipt of [false, true]) {
    const tab = session();
    const state = receipt
      ? { kind: "receipt", requestKey: crypto.randomUUID(), access }
      : {
          kind: "pending",
          request: {
            requestKey: crypto.randomUUID(),
            ...body,
            notes: "Literal <notes>",
            guests: [body.email],
          },
        };
    const raw = JSON.stringify(state);
    const legacyKey = "calflare:create:v1:%2Fintro";
    const obsoleteKey = "calflare:create:v1:%2Fold-intro";
    tab.values.set(legacyKey, raw);
    tab.values.set(obsoleteKey, raw);
    const b = new CreateAttempts({
      storage: tab.storage,
      scope: "/intro",
      eventId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(b.read(), null);
    assert.equal(tab.values.get(legacyKey), raw);
    const store = new CreateAttempts({ storage: tab.storage, scope: "/intro", eventId: "default" });
    tab.fail();
    assert.throws(
      () => store.read(),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "storage_unavailable"
    );
    assert.equal(tab.values.get(legacyKey), raw);
    assert.equal(tab.values.has("calflare:create:v2:default"), false);
    tab.resume();
    const imported = store.read();
    assert.deepEqual(imported, { ...state, eventId: "default" });
    assert.equal(tab.values.has(legacyKey), false);
    assert.equal(tab.values.get(obsoleteKey), raw);
    const renamed = new CreateAttempts({ storage: tab.storage, scope: "/renamed", eventId: "default" });
    assert.deepEqual(renamed.read(), imported);
    assert.ok(imported);
    if (imported.kind === "pending") {
      store.verify(imported);
      assert.equal(JSON.stringify(imported.request), JSON.stringify(state.request));
      store.acknowledge(imported.request.requestKey, access);
    }
    const saved = store.read();
    assert.ok(saved?.kind === "receipt");
    store.clearReceipt(saved.requestKey);
    assert.equal(store.read(), null);
    assert.equal(
      new CreateAttempts({ storage: tab.storage, scope: "/old-intro", eventId: "default" }).read(),
      null
    );
    assert.equal(tab.values.get(obsoleteKey), raw);
  }
});

test("noncanonical v1 attempts cannot be normalized into a replacement or receipt", () => {
  const requestKey = crypto.randomUUID();
  const pending = { kind: "pending", request: { requestKey, ...body } };
  const receipt = { kind: "receipt", requestKey, access };
  const corrupt = [
    JSON.stringify({ ...pending, extra: true }),
    JSON.stringify({ ...pending, request: { ...pending.request, extra: true } }),
    JSON.stringify({ ...pending, request: { ...pending.request, notes: " padded notes " } }),
    JSON.stringify({ ...pending, request: { ...pending.request, guests: ["UPPER@example.test"] } }),
    JSON.stringify({ ...receipt, extra: true }),
    JSON.stringify({ ...receipt, access: { ...access, extra: true } }),
    JSON.stringify(pending, null, 2),
    JSON.stringify({ request: pending.request, kind: "pending" }),
  ];
  for (const raw of corrupt) {
    const tab = session();
    tab.values.set("calflare:create:v1:%2Fintro", raw);
    tab.values.set("calflare:create:v1:%2Fother", "retained legacy attempt");
    tab.values.set("calflare:create:v2:11111111-1111-4111-8111-111111111111", "retained event attempt");
    const before = [...tab.values.entries()];
    const store = new CreateAttempts({ storage: tab.storage, scope: "/intro", eventId: "default" });
    for (const run of [
      () => store.read(),
      () => store.begin(body),
      () => store.acknowledge(requestKey, access),
      () => store.clearReceipt(requestKey),
    ]) {
      assert.throws(
        run,
        (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_saved_attempt"
      );
      assert.deepEqual([...tab.values.entries()], before);
    }
  }
});

test("a failed v1 removal cannot resurrect a cleared receipt", () => {
  const tab = session();
  const raw = JSON.stringify({ kind: "receipt", requestKey: crypto.randomUUID(), access });
  tab.values.set("calflare:create:v1:%2Fintro", raw);
  const store = new CreateAttempts({
    eventId: "default",
    scope: "/intro",
    storage: {
      ...tab.storage,
      removeItem: () => {
        throw new Error("denied");
      },
    },
  });
  assert.throws(() => store.read(), ErrorWithCode);
  assert.equal(tab.values.get("calflare:create:v1:%2Fintro"), raw);
  const saved = store.read();
  assert.ok(saved?.kind === "receipt");
  store.clearReceipt(saved.requestKey);
  assert.equal(store.read(), null);
  assert.equal(tab.values.get("calflare:create:v1:%2Fintro"), raw);
});

test("v2 mismatches and corruption block pending dispatch, receipt lookup and replacement despite valid v1", () => {
  const tab = session();
  const store = new CreateAttempts({ storage: tab.storage, scope: "/intro", eventId: "default" });
  const pending = store.begin(body);
  tab.values.set(
    "calflare:create:v1:%2Fintro",
    JSON.stringify({ kind: "pending", request: pending.request })
  );
  for (const raw of [
    "{",
    JSON.stringify({ ...pending, eventId: "11111111-1111-4111-8111-111111111111" }),
    JSON.stringify({ kind: "receipt", eventId: "wrong", requestKey: pending.request.requestKey, access }),
  ]) {
    tab.values.set("calflare:create:v2:default", raw);
    for (const run of [
      () => store.read(),
      () => store.verify(pending),
      () => store.begin(body),
      () => store.acknowledge(pending.request.requestKey, access),
    ])
      assert.throws(run, ErrorWithCode);
    assert.equal(tab.values.get("calflare:create:v2:default"), raw);
    assert.ok(tab.values.has("calflare:create:v1:%2Fintro"));
  }
});

test("saved guests are immutable, restored, identity fenced and erased by acknowledgment", () => {
  const tab = session(),
    options = { storage: tab.storage, eventId: "default", scope: "/guests" };
  const store = new CreateAttempts(options);
  const guests = ["Z@example.com", body.email];
  const first = store.begin({ ...body, guests });
  assert.deepEqual(first.request.guests, ["z@example.com", body.email]);
  guests[0] = "changed@example.com";
  assert.ok(Object.isFrozen(first.request.guests));
  const restored = new CreateAttempts(options).read();
  assert.deepEqual(restored, first);
  assert.ok(restored?.kind === "pending" && Object.isFrozen(restored.request.guests));
  assert.deepEqual(store.begin({ ...body, guests: ["Z@EXAMPLE.COM", body.email] }), first);
  for (const guests of [[body.email, "z@example.com"], ["other@example.com"]])
    assert.throws(
      () => store.begin({ ...body, guests }),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "booking_in_progress"
    );
  store.acknowledge(first.request.requestKey, access);
  assert.deepEqual(JSON.parse([...tab.values.values()][0] ?? "null"), {
    kind: "receipt",
    eventId: "default",
    requestKey: first.request.requestKey,
    access,
  });
});

test("HTTP-sized guest attempts fit the saved reader and oversize writes preserve prior state", () => {
  const tab = session(),
    options = { storage: tab.storage, eventId: "default", scope: "/large-guests" };
  const store = new CreateAttempts(options);
  const guests = Array.from({ length: 95 }, (_, i) => `${String(i).padStart(242, "a")}@example.com`);
  const escaped = {
    ...body,
    name: "\u0000".repeat(200),
    email: `${"\u0000".repeat(241)}@example.test`,
    notes: `x${"\u0000".repeat(999)}`,
  };
  const oversized = { ...escaped, guests };
  assert.throws(
    () => store.begin(oversized),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "request_too_large"
  );
  assert.equal(tab.values.size, 0);
  const first = store.begin({ ...escaped, guests: guests.slice(0, 90) });
  assert.ok(JSON.stringify(first).length > 16384);
  assert.ok(new TextEncoder().encode(JSON.stringify(first.request)).byteLength <= 32768);
  assert.deepEqual(new CreateAttempts(options).read(), first);
  for (const receipt of [false, true]) {
    if (receipt) store.acknowledge(first.request.requestKey, access);
    const before = [...tab.values.entries()];
    assert.throws(() => store.begin(oversized), ErrorWithCode);
    assert.deepEqual([...tab.values.entries()], before);
  }
});

test("creation request size uses canonical UTF-8 bytes at the exact limit", (t) => {
  const requestKey = "11111111-1111-4111-8111-111111111111";
  t.mock.method(crypto, "randomUUID", () => requestKey);
  const guests = Array.from({ length: 124 }, (_, i) => `${String(i).padStart(242, "a")}@example.com`);
  const prefix =
    '{"requestKey":"11111111-1111-4111-8111-111111111111","start":1893492000000,"name":"Guest","email":"guest@example.test","timeZone":"UTC","notes":"';
  const suffix = `","guests":[${guests.map((email) => `"${email}"`).join(",")}]}`;
  const encoder = new TextEncoder();
  const remaining = 32768 - encoder.encode(prefix + suffix).byteLength;
  const notes = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  const expected = prefix + notes + suffix;
  assert.equal(encoder.encode(expected).byteLength, 32768);
  assert.ok(notes.length <= 1000);
  const tab = session();
  const store = new CreateAttempts({ storage: tab.storage, eventId: "default", scope: "/intro" });
  assert.throws(
    () => store.begin({ ...body, notes: `${notes}x`, guests }),
    (error: unknown) =>
      error instanceof ErrorWithCode && error.code === "request_too_large" && error.status === 413
  );
  assert.equal(tab.values.size, 0);
  const pending = store.begin({ ...body, notes, guests });
  assert.equal(JSON.stringify(pending.request), expected);
  assert.deepEqual(store.read(), pending);
});

test("creation attempts preserve identity, attendee data and late-result fencing", () => {
  const tab = session();
  const options = { storage: tab.storage, eventId: "default", scope: "/organizer/intro" };
  const store = new CreateAttempts(options);
  const first = store.begin(body);
  assert.deepEqual(store.begin(body), first);
  assert.deepEqual(new CreateAttempts(options).read(), first);
  assert.ok(Object.isFrozen(first.request));
  assert.throws(() => store.begin({ ...body, start: body.start + hour }), ErrorWithCode);
  for (const [code, status] of [
    ["network_error", 0],
    ["failure", 408],
    ["failure", 429],
    ["failure", 503],
    ["idempotency_mismatch", 409],
    ["invalid_input", 400],
  ] as const) {
    assert.equal(store.reject(first.request.requestKey, new ErrorWithCode(code, status)), false);
    assert.deepEqual(store.read(), first);
  }
  assert.equal(store.clearReceipt(first.request.requestKey), false);
  const receipt = store.acknowledge(first.request.requestKey, access);
  assert.deepEqual(new CreateAttempts(options).read(), receipt);
  assert.deepEqual(store.acknowledge(first.request.requestKey, access), receipt);
  assert.equal([...tab.values.values()].join("").includes(body.email), false);
  assert.equal([...tab.values.values()].join("").includes('"name"'), false);
  assert.throws(() => store.begin(body), ErrorWithCode);
  assert.equal(store.clearReceipt(crypto.randomUUID()), false);
  assert.equal(store.clearReceipt(receipt.requestKey), true);
  const next = store.begin(body);
  assert.notEqual(next.request.requestKey, first.request.requestKey);
  assert.throws(() => store.acknowledge(first.request.requestKey, access), ErrorWithCode);
  assert.equal(store.reject(first.request.requestKey, new ErrorWithCode("conflict", 409)), false);
  assert.deepEqual(store.read(), next);
  assert.equal(store.reject(next.request.requestKey, new ErrorWithCode("conflict", 409)), true);
  assert.equal(store.read(), null);
});

test("independent booking pages retain separate attempts in the same tab", () => {
  const tab = session();
  const first = new CreateAttempts({ storage: tab.storage, eventId: "default", scope: "/first/event" });
  const second = new CreateAttempts({
    storage: tab.storage,
    eventId: "11111111-1111-4111-8111-111111111111",
    scope: "/second/event",
  });
  const a = first.begin(body),
    b = second.begin(body);
  assert.notEqual(a.request.requestKey, b.request.requestKey);
  first.acknowledge(a.request.requestKey, access);
  assert.deepEqual(second.read(), b);
  first.clearReceipt(a.request.requestKey);
  assert.deepEqual(second.read(), b);
});

test("notes survive reload canonically, fence changed retries and disappear from receipts", () => {
  const tab = session(),
    options = { storage: tab.storage, eventId: "default", scope: "/notes" };
  const store = new CreateAttempts(options);
  const notes = "First line\nSecond line <plain> & text\nThird line 😀";
  const first = store.begin({ ...body, notes: ` \n${notes}\t ` });
  assert.equal(first.request.notes, notes);
  const restored = new CreateAttempts(options).read();
  assert.deepEqual(restored, first);
  assert.ok(restored?.kind === "pending" && Object.isFrozen(restored.request));
  assert.deepEqual(store.begin({ ...body, notes }), first);
  assert.throws(
    () => store.begin({ ...body, notes: `${notes}!` }),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "booking_in_progress"
  );
  assert.deepEqual(store.read(), first);
  store.acknowledge(first.request.requestKey, access);
  assert.deepEqual(JSON.parse([...tab.values.values()][0] ?? "null"), {
    kind: "receipt",
    eventId: "default",
    requestKey: first.request.requestKey,
    access,
  });
  const legacy = new CreateAttempts({ storage: session().storage, eventId: "default", scope: "/legacy" });
  const old = legacy.begin(body);
  assert.deepEqual(legacy.begin({ ...body, notes: " \n ", guests: ["", ""] }), old);
  const escaped = new CreateAttempts({
    storage: tab.storage,
    eventId: "11111111-1111-4111-8111-111111111111",
    scope: "/escaped",
  });
  const large = escaped.begin({
    ...body,
    name: "\u0000".repeat(200),
    email: `${"\u0000".repeat(240)}@example.test`,
    notes: `x${"\u0000".repeat(999)}`,
  });
  assert.ok(JSON.stringify(large).length > 8192);
  assert.deepEqual(
    new CreateAttempts({
      storage: tab.storage,
      eventId: "11111111-1111-4111-8111-111111111111",
      scope: "/escaped",
    }).read(),
    large
  );
});

test("storage failures and corrupt state never authorize a replacement attempt", () => {
  const tab = session();
  const store = new CreateAttempts({ storage: tab.storage, eventId: "default", scope: "/intro" });
  tab.fail();
  assert.throws(
    () => store.begin(body),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "storage_unavailable"
  );
  assert.equal(tab.values.size, 0);
  tab.resume();
  const first = store.begin({ ...body, notes: "Retain this pending note" });
  const before = [...tab.values.entries()];
  tab.fail();
  assert.throws(() => store.acknowledge(first.request.requestKey, access), ErrorWithCode);
  assert.deepEqual([...tab.values.entries()], before);
  assert.deepEqual(store.read(), first);
  tab.resume();
  const unreadable = new CreateAttempts({
    eventId: "default",
    scope: "/intro",
    storage: {
      ...tab.storage,
      getItem: () => {
        throw new Error("storage denied");
      },
    },
  });
  assert.throws(
    () => unreadable.begin(body),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "storage_unavailable"
  );
  assert.deepEqual([...tab.values.entries()], before);
  const key = [...tab.values.keys()][0];
  assert.ok(key);
  for (const raw of [
    "{",
    "null",
    JSON.stringify({ ...first, request: { ...first.request, requestKey: "invalid" } }),
    "x".repeat(16385),
    ...[null, 1, false, [], {}, "x".repeat(1001)].map((notes) =>
      JSON.stringify({ ...first, request: { ...first.request, notes } })
    ),
    ...[null, "a@example.com", {}, [false], ["", "a@example.com"], ["A@example.com", "a@example.com"]].map(
      (guests) => JSON.stringify({ ...first, request: { ...first.request, guests } })
    ),
    "x".repeat(65537),
    JSON.stringify({
      ...first,
      request: {
        ...first.request,
        guests: Array.from({ length: 160 }, (_, i) => `${String(i).padStart(242, "a")}@example.com`),
      },
    }),
  ]) {
    tab.values.set(key, raw);
    assert.throws(
      () => store.begin(body),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_saved_attempt"
    );
    assert.equal(tab.values.get(key), raw);
  }
});

test("a reloaded creation attempt recovers a lost HTTP acknowledgment without another event", async (t) => {
  const { apiFixture } = await import("./fixtures/api.ts");
  const fixture = await apiFixture();
  t.after(fixture.close);
  const client = new BookerClient((path, init) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", fixture.env.PUBLIC_ORIGIN);
    return fixture.request(path, { ...init, headers });
  });
  const tab = session(),
    options = { storage: tab.storage, eventId: "default", scope: "/intro" };
  const store = new CreateAttempts(options);
  const first = store.begin({
    ...body,
    start: fixture.now() + 10 * hour,
    notes: "Literal <notes>\nSecond line",
  });
  await client.create(first.request);
  const reloaded = new CreateAttempts(options);
  const saved = reloaded.read();
  assert.equal(saved?.kind, "pending");
  assert.ok(saved?.kind === "pending");
  const recovered = await client.create(saved.request);
  reloaded.acknowledge(saved.request.requestKey, { id: recovered.id, token: recovered.manageToken });
  assert.equal(fixture.calendar.writes.length, 1);
  assert.equal(reloaded.read()?.kind, "receipt");
  assert.equal([...tab.values.values()].join("").includes(body.email), false);
});
