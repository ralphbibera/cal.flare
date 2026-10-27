import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { AuthEnv } from "../src/server/auth.ts";
import type { EventInput } from "../src/server/google.ts";
import { GoogleCalendar, GoogleCalendarError } from "../src/server/google.ts";
import { encryptionKey, seal } from "../src/server/secrets.ts";

const platform = await getPlatformProxy<{ DB: D1Database }>({
  configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  persist: false,
  remoteBindings: false,
});
const env: AuthEnv = {
  DB: platform.env.DB,
  PUBLIC_ORIGIN: "https://calendar.example.com",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_OWNER_EMAIL: "owner@example.com",
  TOKEN_ENCRYPTION_KEY: btoa("k".repeat(32)),
};
let handler: typeof fetch = async () => {
  throw new Error("Unexpected mock request");
};
const client = new GoogleCalendar(env, (input, init) => {
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access");
  assert.equal(init?.redirect, "manual");
  return handler(input, init);
});
const input: EventInput = {
  id: "abcde12345",
  start: "2026-11-02T10:00:00Z",
  end: "2026-11-02T11:00:00Z",
  timeZone: "Europe/London",
  title: "Intro",
  description: "Booked meeting",
  attendee: { name: "Guest", email: "guest@example.com" },
  privateMetadata: { bookingId: "booking-1" },
};
const failure = (kind: string, status: number) => (error: unknown) =>
  error instanceof GoogleCalendarError && error.kind === kind && error.status === status;
try {
  const migration = await readFile(new URL("../migrations/0001_identity.sql", import.meta.url), "utf8");
  await env.DB.batch(
    migration
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => env.DB.prepare(sql))
  );
  await env.DB.prepare("INSERT INTO owner VALUES ('owner', 'subject', 'owner@example.com', 'Owner')").run();
  await env.DB.prepare("INSERT INTO google_connection VALUES ('owner', ?, 1)")
    .bind(
      await seal(
        await encryptionKey(env.TOKEN_ENCRYPTION_KEY),
        JSON.stringify({ access: "test-access", refresh: "test-refresh", expiresAt: Date.now() + 3600_000 }),
        "google:owner"
      )
    )
    .run();
  handler = async (url, init) => {
    assert.equal(
      String(url),
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all"
    );
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.id, input.id, "Retries use a caller-assigned stable event ID");
    assert.equal(payload.attendees.length, 1);
    assert.equal(payload.attendees[0].email, "guest@example.com");
    assert.equal(
      payload.attendees[0].responseStatus,
      undefined,
      "Invitations must never auto-accept the attendee"
    );
    return Response.json({ id: input.id, etag: '"v1"' });
  };
  assert.deepEqual(await client.insert(input), { id: input.id, etag: '"v1"' });
  for (const operation of ["PATCH", "DELETE"]) {
    handler = async (url, init) => {
      assert.equal(
        String(url),
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${input.id}?sendUpdates=all`
      );
      assert.equal(init?.method, operation);
      assert.equal(
        new Headers(init?.headers).get("If-Match"),
        '"v1"',
        "Mutations must reject overwriting an independently changed event"
      );
      return operation === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: input.id, etag: '"v2"' });
    };
    if (operation === "PATCH") await client.update(input.id, '"v1"', input);
    else await client.delete(input.id, '"v1"');
  }
  await assert.rejects(client.delete(input.id, "*"), /concrete/);
  handler = async () => new Response(null, { status: 412 });
  await assert.rejects(client.update(input.id, '"old"', input), failure("definite", 412));
  handler = async () => new Response(null, { status: 503 });
  await assert.rejects(client.insert(input), failure("ambiguous", 503));
  await assert.rejects(client.get(input.id), failure("retryable", 503));
  handler = async () => new Response(null, { status: 429 });
  await assert.rejects(client.insert(input), failure("retryable", 429));
  handler = async () => {
    throw new Error("connection reset after write");
  };
  await assert.rejects(client.delete(input.id, '"v1"'), failure("ambiguous", 0));
  handler = async () => Response.json({ id: input.id });
  await assert.rejects(client.insert(input), failure("ambiguous", 200));
  for (const etag of [
    "*",
    "unquoted",
    'W/"weak"',
    '"line\r\nbreak"',
    ...Array.from({ length: 33 }, (_, code) => `"bad${String.fromCharCode(code)}tag"`),
    '"bad\x7ftag"',
    '"Ā"',
    '"😀"',
    '"v1"\n',
    '"v1"\r',
    '"v1"\u2028',
    '"v1"\u2029',
  ]) {
    handler = async () =>
      Response.json({ id: input.id, etag, start: { dateTime: input.start }, end: { dateTime: input.end } });
    await assert.rejects(client.insert(input), failure("ambiguous", 200));
    await assert.rejects(client.update(input.id, '"v1"', input), failure("ambiguous", 200));
    await assert.rejects(client.get(input.id), failure("retryable", 200));
  }
  for (const etag of ['""', '"v2"', '"!#~\\\x80\xff"']) {
    handler = async (_url, init) => {
      if (init?.method === "DELETE") {
        assert.equal(new Headers(init.headers).get("If-Match"), etag);
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: input.id, etag });
    };
    const created = await client.insert(input);
    assert.equal(created.etag, etag);
    const updated = await client.update(input.id, created.etag, input);
    assert.equal(updated.etag, etag);
    await client.delete(input.id, updated.etag);
  }
  const expected = {
    id: input.id,
    etag: '"read-v1"',
    start: { dateTime: input.start },
    end: { dateTime: input.end },
    attendees: [{ email: "guest@example.com" }],
    extendedProperties: { private: { bookingId: "booking-1" } },
  };
  handler = async () => Response.json(expected);
  assert.deepEqual(await client.get(input.id), expected);
  handler = async () => new Response(null, { status: 404 });
  await assert.rejects(client.get(input.id), failure("definite", 404));
  handler = async (url) =>
    String(url).endsWith("?maxResults=1")
      ? Response.json({ items: [] })
      : new Response(null, { status: 404 });
  assert.equal(await client.get(input.id), null);
  handler = async () => Response.json({ id: input.id, status: "cancelled" });
  assert.equal(await client.get(input.id), null, "A cancelled tombstone need not contain times");
  handler = async () => new Response(null, { status: 403 });
  await assert.rejects(client.get(input.id), failure("definite", 403));
  for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "forbidden"]) {
    handler = async () =>
      Response.json({ error: { message: "private-upstream-detail", errors: [{ reason }] } }, { status: 403 });
    for (const operation of [() => client.get(input.id), () => client.insert(input)])
      await assert.rejects(
        operation(),
        (error: unknown) =>
          failure(reason === "forbidden" ? "definite" : "retryable", 403)(error) &&
          error instanceof Error &&
          !error.message.includes("private-upstream-detail")
      );
  }
  for (const body of [
    "not json",
    JSON.stringify({ error: { errors: [null, { reason: 123 }] } }),
    JSON.stringify({ padding: "x".repeat(20_000), error: { errors: [{ reason: "rateLimitExceeded" }] } }),
  ]) {
    handler = async () => new Response(body, { status: 403 });
    await assert.rejects(client.insert(input), failure("definite", 403));
  }
  const from = "2026-11-02T00:00:00Z",
    to = "2026-11-03T00:00:00Z";
  handler = async () =>
    Response.json({ calendars: { primary: { errors: [{ reason: "notFound" }], busy: [] } } });
  await assert.rejects(client.freeBusy(from, to), failure("retryable", 200));
  handler = async () => Response.json({ calendars: { primary: { busy: [{ start: to, end: from }] } } });
  await assert.rejects(client.freeBusy(from, to), failure("retryable", 200));
  let pages = 0;
  handler = async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get("singleEvents"), "true");
    pages++;
    if (!parsed.searchParams.has("pageToken"))
      return Response.json({
        items: [
          { id: input.id, start: { dateTime: input.start }, end: { dateTime: input.end } },
          { id: `${input.id}-similar`, start: { dateTime: input.start }, end: { dateTime: input.end } },
          { id: "cancelled", status: "cancelled" },
          { id: "transparent", transparency: "transparent" },
        ],
        nextPageToken: "page-two",
      });
    assert.equal(parsed.searchParams.get("pageToken"), "page-two");
    return Response.json({
      items: [
        {
          id: "all-day",
          start: { date: "2026-11-02", timeZone: "Pacific/Auckland" },
          end: { date: "2026-11-03" },
        },
      ],
    });
  };
  assert.deepEqual(
    await client.busy(from, to, input.id),
    [
      { start: Date.parse(String(input.start)), end: Date.parse(String(input.end)) },
      { start: Date.parse(from), end: Date.parse("2026-11-02T11:00:00Z") },
    ],
    "Only the exact rescheduled event is excluded; all-day occupancy is conservative"
  );
  assert.equal(pages, 2);
  handler = async () =>
    Response.json({
      timeZone: "America/New_York",
      items: [{ id: "dst-day", start: { date: "2026-03-08" }, end: { date: "2026-03-09" } }],
    });
  assert.deepEqual(
    await client.busy("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
    [{ start: Date.parse("2026-03-08T05:00:00Z"), end: Date.parse("2026-03-09T04:00:00Z") }],
    "A DST all-day event blocks its actual 23-hour local day, not the queried month"
  );
  handler = async () =>
    Response.json({
      timeZone: "America/New_York",
      items: [{ id: "dst-day", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }],
    });
  assert.deepEqual(
    await client.busy("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"),
    [{ start: Date.parse("2026-11-01T04:00:00Z"), end: Date.parse("2026-11-02T05:00:00Z") }],
    "A DST fall-back all-day event blocks its actual 25-hour local day"
  );
  let boundedPages = 0;
  handler = async () => Response.json({ items: [], nextPageToken: `page-${++boundedPages}` });
  await assert.rejects(client.busy(from, to), /pagination limit/);
  assert.equal(boundedPages, 10, "Availability cannot spend the Worker subrequest budget on unbounded pages");
  handler = async () => Response.json({ items: [], nextPageToken: "repeated" });
  await assert.rejects(client.busy(from, to), /pagination cursor/);
  handler = async () =>
    Response.json({
      items: [{ id: "malformed", start: { dateTime: "2026-11-02T12:00:00" }, end: { dateTime: to } }],
    });
  await assert.rejects(client.busy(from, to), failure("retryable", 200));
  await env.DB.prepare("DELETE FROM google_connection").run();
  let dispatched = 0;
  handler = async () => {
    dispatched++;
    throw new Error("A disconnected owner must not send a Calendar request");
  };
  await assert.rejects(
    client.get(input.id),
    (error: unknown) =>
      error instanceof GoogleCalendarError && error.dispatched === false && error.status === 0
  );
  assert.equal(dispatched, 0);
  await assert.rejects(
    client.insert(input),
    (error: unknown) =>
      error instanceof GoogleCalendarError && error.dispatched === false && error.status === 0
  );
  assert.equal(dispatched, 0);
  console.log(
    "PASS Calendar invitation payloads, stable IDs, ETags, failure classification, exact exclusion, pagination and all-day availability (mocked Google only)"
  );
} finally {
  await platform.dispose();
}
