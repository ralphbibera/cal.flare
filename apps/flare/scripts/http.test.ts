import assert from "node:assert/strict";
import { test } from "node:test";
import { bearer, body, ErrorWithCode, respond, sameOrigin } from "../src/server/http.ts";

test("state-changing requests require the exact configured origin", () => {
  sameOrigin(
    new Request("https://cal.example/api/bookings", { headers: { Origin: "https://cal.example" } }),
    "https://cal.example"
  );
  for (const origin of [undefined, "null", "https://cal.example.attacker.test", "http://cal.example"]) {
    const request = new Request("https://cal.example/api/bookings", {
      headers: origin ? { Origin: origin } : {},
    });
    assert.throws(() => sameOrigin(request, "https://cal.example"), { code: "invalid_origin" });
  }
});

test("JSON bodies enforce byte limits even without Content-Length", async () => {
  const request = (value: string, contentType = "application/json") =>
    new Request("https://cal.example", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: value,
    });
  assert.deepEqual(await body(request('{"start":123}')), { start: 123 });
  await assert.rejects(body(request("{broken")), { code: "invalid_json" });
  await assert.rejects(body(request("{}", "text/plain")), { code: "json_required" });
  await assert.rejects(body(request("{}", "application/jsonp")), { code: "json_required" });
  assert.deepEqual(await body(request("{}", "Application/JSON; charset=utf-8")), {});
  await assert.rejects(
    body(
      new Request("https://cal.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Uint8Array.of(0x22, 0xc3, 0x28, 0x22),
      })
    ),
    { code: "invalid_json" }
  );
  await assert.rejects(body(request(JSON.stringify("é".repeat(20000)))), { code: "request_too_large" });
});

test("malformed UTF-8 cancels an unread request stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(0x22, 0xc3, 0x28, 0x22));
    },
    cancel() {
      cancelled = true;
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  };
  await assert.rejects(body(new Request("https://cal.example", init)), { code: "invalid_json" });
  assert.equal(cancelled, true);
});

test("capabilities are accepted only from a bounded Bearer header", () => {
  const token = "x".repeat(43);
  assert.equal(
    bearer(new Request("https://cal.example", { headers: { Authorization: `Bearer ${token}` } })),
    token
  );
  for (const authorization of ["", "Basic abc", "Bearer short", `Bearer ${"x".repeat(257)}`]) {
    assert.throws(
      () => bearer(new Request("https://cal.example", { headers: { Authorization: authorization } })),
      { code: "unauthorized" }
    );
  }
});

test("HTTP error responses preserve status and exclude exception details", async () => {
  const request = new Request("https://cal.example/api/bookings");
  const invalid = await respond(request, async () => {
    throw new ErrorWithCode("invalid_input", 422);
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await invalid.json(), { error: "invalid_input", message: "invalid_input" });
  for (const code of ["GOOGLE_CALENDAR", "TOKEN_NETWORK", "OAUTH_IDENTITY", "UPSTREAM_SHAPE"]) {
    const upstream = await respond(request, async () => {
      throw Object.assign(new Error("private token"), { code });
    });
    assert.equal(upstream.status, 503);
    assert.deepEqual(await upstream.json(), { error: code });
  }
  const origin = await respond(request, async () => {
    throw Object.assign(new Error("private context"), { code: "ORIGIN" });
  });
  assert.equal(origin.status, 403);
  assert.deepEqual(await origin.json(), { error: "ORIGIN" });
  const range = await respond(request, async () => {
    throw new RangeError("internal detail");
  });
  assert.equal(range.status, 400);
  assert.deepEqual(await range.json(), { error: "invalid_range" });
});
