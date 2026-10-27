import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { AuthEnv } from "../src/server/auth.ts";
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
const input = {
  id: "abcde12345",
  start: "2026-11-02T10:00:00Z",
  end: "2026-11-02T11:00:00Z",
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
    await assert.rejects(
      client.get(input.id),
      (error: unknown) =>
        failure(reason === "forbidden" ? "definite" : "retryable", 403)(error) &&
        error instanceof Error &&
        !error.message.includes("private-upstream-detail")
    );
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
  let boundedPages = 0;
  handler = async () => Response.json({ items: [], nextPageToken: `page-${++boundedPages}` });
  await assert.rejects(client.busy(from, to), /pagination limit/);
  assert.equal(boundedPages, 10, "Availability cannot spend the Worker subrequest budget on unbounded pages");
  handler = async () => Response.json({ items: [], nextPageToken: "repeated" });
  await assert.rejects(client.busy(from, to), /pagination cursor/);
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
  console.log(
    "PASS Calendar read failure classification, access probes, exact exclusion, pagination and all-day availability (mocked Google only)"
  );
} finally {
  await platform.dispose();
}
