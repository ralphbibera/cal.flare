import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { CreateAttempts } from "../src/client/create-attempt.ts";
import { apiFixture, hour } from "./fixtures/api.ts";

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

test("creation attempts preserve identity, attendee data and late-result fencing", () => {
  const tab = session();
  const options = { storage: tab.storage, scope: "/organizer/intro" };
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
  const first = new CreateAttempts({ storage: tab.storage, scope: "/first/event" });
  const second = new CreateAttempts({ storage: tab.storage, scope: "/second/event" });
  const a = first.begin(body),
    b = second.begin(body);
  assert.notEqual(a.request.requestKey, b.request.requestKey);
  first.acknowledge(a.request.requestKey, access);
  assert.deepEqual(second.read(), b);
  first.clearReceipt(a.request.requestKey);
  assert.deepEqual(second.read(), b);
});

test("storage failures and corrupt state never authorize a replacement attempt", () => {
  const tab = session();
  const store = new CreateAttempts({ storage: tab.storage, scope: "/intro" });
  tab.fail();
  assert.throws(
    () => store.begin(body),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "storage_unavailable"
  );
  assert.equal(tab.values.size, 0);
  tab.resume();
  const first = store.begin(body);
  const before = [...tab.values.entries()];
  tab.fail();
  assert.throws(() => store.acknowledge(first.request.requestKey, access), ErrorWithCode);
  assert.deepEqual([...tab.values.entries()], before);
  assert.deepEqual(store.read(), first);
  tab.resume();
  const unreadable = new CreateAttempts({
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
    "x".repeat(8193),
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
  const fixture = await apiFixture();
  t.after(fixture.close);
  const client = new BookerClient((path, init) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", fixture.env.PUBLIC_ORIGIN);
    return fixture.request(path, { ...init, headers });
  });
  const tab = session(),
    options = { storage: tab.storage, scope: "/intro" };
  const store = new CreateAttempts(options);
  const first = store.begin({ ...body, start: fixture.now() + 10 * hour });
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
