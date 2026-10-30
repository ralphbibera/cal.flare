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
  guests: ["extra@example.com", "GUEST@example.com"],
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
    const query = new URL(String(url));
    assert.equal(query.pathname, "/calendar/v3/users/me/calendarList");
    assert.equal(query.searchParams.get("maxResults"), "250");
    assert.equal(query.searchParams.get("showHidden"), "true");
    assert.equal(query.searchParams.get("showDeleted"), "false");
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    return Response.json({
      items: [{ id: "Owner@Example.com", summary: "Private name", primary: true, accessRole: "owner" }],
    });
  };
  assert.deepEqual(await client.listCalendars(), [{ id: "primary", name: "Private name", primary: true }]);
  const entry = (id: string, accessRole = "reader") => ({ id, summary: `Name ${id}`, accessRole });
  let listPages = 0;
  handler = async (url) => {
    const page = new URL(String(url)).searchParams.get("pageToken");
    listPages++;
    if (!page)
      return Response.json({
        items: [
          { ...entry("Owner@Example.com", "owner"), primary: true },
          { ...entry("Hidden@group.calendar.google.com", "freeBusyReader"), hidden: true, selected: false },
          entry("en.usa#holiday@group.v.calendar.google.com"),
          entry("addressbook#contacts@group.v.calendar.google.com"),
          { id: "deleted", deleted: true },
          entry("no-access", "none"),
        ],
        nextPageToken: "second+page",
      });
    assert.equal(page, "second+page");
    return Response.json({
      items: [entry("CaseSensitive@Group.calendar.google.com", "writer"), entry("read-only")],
    });
  };
  assert.deepEqual(await client.listCalendars(), [
    { id: "primary", name: "Name Owner@Example.com", primary: true },
    { id: "Hidden@group.calendar.google.com", name: "Name Hidden@group.calendar.google.com", primary: false },
    {
      id: "CaseSensitive@Group.calendar.google.com",
      name: "Name CaseSensitive@Group.calendar.google.com",
      primary: false,
    },
    { id: "read-only", name: "Name read-only", primary: false },
  ]);
  assert.equal(listPages, 2);
  for (const items of [
    [entry("same"), entry("same")],
    [
      { ...entry("first"), primary: true },
      { ...entry("second"), primary: true },
    ],
    [entry("primary")],
    [entry("")],
    [entry(" padded ")],
    [entry("bad\u0000id")],
    [entry("bad\u0080id")],
    [entry("bad\u0085id")],
    [entry("bad\u009fid")],
    [entry("a".repeat(1025))],
    [{ ...entry("id"), summary: " " }],
    [{ ...entry("id"), summary: 3 }],
    [{ ...entry("id"), primary: "true" }],
    [{ ...entry("id"), hidden: 1 }],
    [{ ...entry("id"), deleted: "true" }],
    [entry("id", "unexpected-role")],
    [null],
    ["id"],
  ]) {
    handler = async () => Response.json({ items });
    await assert.rejects(client.listCalendars(), failure("retryable", 200));
  }
  for (const value of [
    {},
    null,
    { items: null },
    { items: [], nextPageToken: "" },
    { items: [], nextPageToken: " " },
    { items: [], nextPageToken: 3 },
  ]) {
    handler = async () => Response.json(value);
    await assert.rejects(client.listCalendars(), failure("retryable", 200));
  }
  for (const scenario of ["repeat", "duplicate", "pages", "count", "page-size"]) {
    listPages = 0;
    handler = async () => {
      const current = listPages++;
      return Response.json({
        items:
          scenario === "count" || scenario === "page-size"
            ? Array.from({ length: scenario === "count" ? 250 : 251 }, (_, n) => entry(`id-${current}-${n}`))
            : scenario === "duplicate"
              ? [entry("same")]
              : [],
        nextPageToken: scenario === "repeat" ? "repeated" : `page-${current}`,
      });
    };
    await assert.rejects(client.listCalendars(), failure("retryable", 200));
    assert.equal(listPages, { repeat: 2, duplicate: 2, pages: 10, count: 5, "page-size": 1 }[scenario]);
  }
  for (const status of [403, 429, 503]) {
    handler = async () =>
      Response.json({ error: { message: "PRIVATE NAME / PRIVATE ID / TOKEN" } }, { status });
    await assert.rejects(client.listCalendars(), (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError);
      assert.equal(error.kind, status === 403 ? "definite" : "retryable");
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("PRIVATE"));
      return true;
    });
  }
  listPages = 0;
  handler = async () => {
    const current = listPages++;
    return Response.json({
      items: Array.from({ length: 250 }, (_, n) => entry(`id-${current}-${n}`)),
      ...(current < 3 ? { nextPageToken: `page-${current}` } : {}),
    });
  };
  assert.equal((await client.listCalendars()).length, 1000);
  for (const invalid of [
    { id: "partial-private-id", summary: "Private name", accessRole: "invalid" },
    entry("bad\u0080id"),
    entry("bad\u0085id"),
    entry("bad\u009fid"),
  ]) {
    listPages = 0;
    handler = async () =>
      Response.json(
        listPages++ === 0
          ? { items: [entry("partial-private-id")], nextPageToken: "next" }
          : { items: [invalid] }
      );
    await assert.rejects(client.listCalendars(), failure("retryable", 200));
    assert.equal(listPages, 2);
  }
  handler = async () => {
    throw new Error("PRIVATE transport details");
  };
  await assert.rejects(client.listCalendars(), failure("retryable", 0));
  handler = async () => new Response("PRIVATE malformed response", { status: 200 });
  await assert.rejects(client.listCalendars(), failure("retryable", 200));
  handler = async () => Response.json({ items: [] });
  assert.deepEqual(await client.listCalendars(), []);
  handler = async (url, init) => {
    assert.equal(
      String(url),
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all"
    );
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.id, input.id, "Retries use a caller-assigned stable event ID");
    assert.deepEqual(payload.attendees, [
      { email: "guest@example.com", displayName: "Guest" },
      { email: "extra@example.com" },
    ]);
    assert.equal(payload.attendees[0].email, "guest@example.com");
    assert.equal(
      payload.attendees[0].responseStatus,
      undefined,
      "Invitations must never auto-accept the attendee"
    );
    return Response.json({ id: input.id, etag: '"v1"' });
  };
  assert.deepEqual(await client.insert(input), { id: input.id, etag: '"v1"' });
  for (const location of [undefined, 'Room A\r\n東京 😀 <literal>"&']) {
    const located = { ...input, ...(location === undefined ? {} : { location }) };
    handler = async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get("sendUpdates"), "all");
      const payload = JSON.parse(String(init?.body));
      assert.equal(Object.hasOwn(payload, "location"), location !== undefined);
      assert.equal(payload.location, location);
      if (init?.method === "PATCH") assert.equal(new Headers(init.headers).get("If-Match"), '"v1"');
      else assert.equal(init?.method, "POST");
      return Response.json({ id: input.id, etag: '"v2"' });
    };
    await client.insert(located);
    await client.update(input.id, '"v1"', located);
  }
  for (const location of ["", " padded ", "x".repeat(1001)]) {
    await assert.rejects(client.insert({ ...input, location }), /Invalid event location/);
    await assert.rejects(client.update(input.id, '"v1"', { ...input, location }), /Invalid event location/);
  }
  for (const location of ["", "x".repeat(1001), " External\r\n東京 <literal> ", null, 3]) {
    handler = async () =>
      Response.json({
        id: input.id,
        etag: '"v1"',
        location,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
      });
    if (typeof location === "string") assert.equal((await client.get(input.id))?.location, location);
    else await assert.rejects(client.get(input.id), failure("retryable", 200));
  }
  for (const operation of ["PATCH", "DELETE"]) {
    handler = async (url, init) => {
      assert.equal(
        String(url),
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${input.id}?sendUpdates=all`
      );
      assert.equal(init?.method, operation);
      if (operation === "PATCH")
        assert.deepEqual(JSON.parse(String(init?.body)).attendees, [
          { email: input.attendee.email, displayName: input.attendee.name },
          { email: "extra@example.com" },
        ]);
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
  assert.deepEqual(await client.get(input.id), { ...expected, calendarOwnerEmail: env.GOOGLE_OWNER_EMAIL });
  const attendees = [
    { email: "extra@example.com", displayName: "", additionalGuests: 1 },
    ...expected.attendees,
  ];
  handler = async () =>
    Response.json({
      ...expected,
      attendees,
      calendarOwnerEmail: "untrusted@example.com",
      attendeesOmitted: true,
    });
  assert.deepEqual(await client.get(input.id), {
    ...expected,
    attendees,
    attendeesOmitted: true,
    calendarOwnerEmail: env.GOOGLE_OWNER_EMAIL,
  });
  for (const partial of [
    { attendeesOmitted: "true" },
    ...[-1, 0.5, "1", null].map((additionalGuests) => ({
      attendees: [{ email: "extra@example.com", additionalGuests }],
    })),
    { attendees: [{ email: "extra@example.com", displayName: 1 }] },
  ]) {
    handler = async () => Response.json({ ...expected, ...partial });
    await assert.rejects(client.get(input.id), failure("retryable", 200));
  }
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
          {
            id: input.id,
            start: { dateTime: input.start },
            end: { dateTime: input.end },
            extendedProperties: { private: { application: "calflare", booking: input.id } },
          },
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
      items: [{ id: input.id, start: { dateTime: input.start }, end: { dateTime: input.end } }],
    });
  assert.equal(
    (await client.busy(from, to, input.id)).length,
    1,
    "An ID without ownership markers must still block"
  );
  handler = async () => {
    throw new Error("Empty selection must not read Google");
  };
  assert.deepEqual(await client.busy(from, to, undefined, []), []);
  const ids = ["secondary", "Other"];
  let secondaryReads = 0;
  handler = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/calendar/v3/freeBusy");
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload, {
      timeMin: from,
      timeMax: to,
      calendarExpansionMax: 50,
      items: ids.map((id) => ({ id })),
    });
    secondaryReads++;
    return Response.json({
      calendars: {
        secondary: { busy: [{ start: "2026-11-01T00:00:00Z", end: input.end }] },
        Other: { busy: [] },
      },
    });
  };
  assert.deepEqual(await client.busy(from, to, input.id, ids), [
    { start: Date.parse(from), end: Date.parse(String(input.end)) },
  ]);
  assert.equal(secondaryReads, 1);
  for (const outside of [false, true]) {
    handler = async (url) =>
      new URL(String(url)).pathname.endsWith("/freeBusy")
        ? Response.json({
            calendars: {
              secondary: {
                busy: Array.from({ length: 10000 }, () => ({
                  start: outside ? "2026-01-01T00:00:00Z" : from,
                  end: outside ? "2026-01-02T00:00:00Z" : to,
                })),
              },
            },
          })
        : Response.json({ items: [{ id: "external", start: { dateTime: from }, end: { dateTime: to } }] });
    await assert.rejects(
      client.busy(from, to, undefined, ["secondary", "primary"]),
      failure("retryable", 200)
    );
  }
  handler = async (url) =>
    new URL(String(url)).pathname.endsWith("/freeBusy")
      ? Response.json({
          calendars: {
            secondary: {
              busy: Array.from({ length: 9999 }, () => ({
                start: "2026-01-01T00:00:00Z",
                end: "2026-01-02T00:00:00Z",
              })),
            },
          },
        })
      : Response.json({ items: [{ id: "external", start: { dateTime: from }, end: { dateTime: to } }] });
  assert.deepEqual(await client.busy(from, to, undefined, ["secondary", "primary"]), [
    { start: Date.parse(from), end: Date.parse(to) },
  ]);
  for (const bad of [
    undefined,
    null,
    {},
    { errors: [{ reason: "forbidden" }], busy: [] },
    { errors: "bad", busy: [] },
    { busy: [{ start: to, end: from }] },
    { busy: [{ start: "bad", end: to }] },
    { busy: Array.from({ length: 10001 }, () => ({ start: from, end: to })) },
  ]) {
    handler = async () =>
      Response.json({ calendars: { secondary: { busy: [] }, ...(bad === undefined ? {} : { Other: bad }) } });
    await assert.rejects(client.busy(from, to, undefined, ids), failure("retryable", 200));
  }
  for (const markers of [
    undefined,
    { application: "other", booking: input.id },
    { application: "calflare", booking: "wrong" },
  ]) {
    handler = async () =>
      Response.json({
        items: [
          {
            id: input.id,
            start: { dateTime: input.start },
            end: { dateTime: input.end },
            ...(markers ? { extendedProperties: { private: markers } } : {}),
          },
        ],
      });
    assert.equal((await client.busy(from, to, input.id, ["primary"])).length, 1);
  }
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
