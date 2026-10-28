import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { encryptionKey, seal, unseal } from "../src/server/secrets.ts";
import { hour, settings as httpSettings } from "./fixtures/api.ts";
import { createGoogleFixture } from "./fixtures/google.mjs";

const require = createRequire(import.meta.url);
const { convertV4MiniflareOptions, Miniflare } = createRequire(require.resolve("wrangler/package.json"))(
  "miniflare"
);

const app = fileURLToPath(new URL("../", import.meta.url));
const input = (start) => ({
  requestKey: randomBytes(18).toString("hex"),
  start,
  name: "Fixture Guest",
  email: "guest@example.test",
  timeZone: "UTC",
});
const auth = (booking) => ({ Authorization: `Bearer ${booking.manageToken}` });
const settings = { ...httpSettings, event: { ...httpSettings.event, intervalMinutes: 30 } };

async function loginWithFixture(request, google, read) {
  const begin = await request("/api/auth/login");
  assert.equal(begin.status, 303);
  const url = new URL(begin.headers.get("location"));
  const cookie = begin.headers
    .getSetCookie()
    .find((value) => value.startsWith("flare_oauth="))
    .split(";")[0];
  const callback = `/api/auth/callback?${new URLSearchParams({ state: url.searchParams.get("state"), code: google.authorize(url) })}`;
  assert.equal((await read(await request(callback), 400)).error, "OAUTH_STATE");
  const finish = await request(callback, { headers: { Cookie: cookie } });
  assert.equal(finish.status, 303, `OAuth callback completes through built Worker: ${await finish.text()}`);
  const session = finish.headers.getSetCookie().find((value) => value.startsWith("flare_session="));
  assert.ok(session.includes("HttpOnly") && session.includes("SameSite=Lax"));
  assert.equal(
    (await read(await request(callback, { headers: { Cookie: cookie } }), 400)).error,
    "OAUTH_STATE"
  );
  return { Cookie: session.split(";")[0] };
}

async function createWorkerFixture({ port = 8794, fixedTime } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const temporary = await mkdtemp(join(tmpdir(), "calflare-worker-"));
  const google = createGoogleFixture(origin);
  const upstreamFailures = [];
  let mf;
  const close = async () => {
    try {
      await mf?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  try {
    const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
    for (const name of ["0001_identity.sql", "0002_settings.sql", "0003_bookings.sql", "0004_http.sql"]) {
      await promisify(execFile)(
        process.execPath,
        [
          wrangler,
          "d1",
          "execute",
          "calflare",
          "--local",
          "--persist-to",
          temporary,
          "--file",
          join(app, "migrations", name),
          "--config",
          join(app, "wrangler.jsonc"),
        ],
        { env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }
      );
    }
    const { workerOptions, main } = unstable_getMiniflareWorkerOptions(
      join(app, "dist/server/wrangler.json")
    );
    delete workerOptions.modulesRules;
    const serverRoot = dirname(main);
    const modules = (await readdir(serverRoot, { recursive: true }))
      .filter((name) => name.endsWith(".mjs") || name.endsWith(".js"))
      .map((name) => ({ type: "ESModule", path: join(serverRoot, name) }));
    modules.sort((left, right) => Number(right.path === main) - Number(left.path === main));
    if (fixedTime !== undefined) {
      assert.ok(Number.isSafeInteger(fixedTime), "Use a fixed timestamp for the reference fixture");
      modules.unshift({
        type: "ESModule",
        path: join(serverRoot, "fixture-clock.mjs"),
        contents: `
          const NativeDate = Date;
          const nativeTimeout = setTimeout;
          const nativePerformance = performance;
          const time = ${JSON.stringify(fixedTime)};
          globalThis.Date = new Proxy(NativeDate, {
            apply() { return new NativeDate(time).toString(); },
            construct(target, args, newTarget) {
              return Reflect.construct(target, args.length ? args : [time], newTarget);
            },
            get(target, key, receiver) {
              return key === "now" ? () => time : Reflect.get(target, key, receiver);
            },
          });
          if (Date.now() !== time || new Date().getTime() !== time ||
              setTimeout !== nativeTimeout || performance !== nativePerformance) {
            throw new Error("Reference clock changed native timers");
          }
          const { default: worker } = await import(${JSON.stringify(`./${basename(main)}`)});
          export default worker;
        `,
      });
    }
    const bindings = {
      PUBLIC_ORIGIN: origin,
      GOOGLE_OWNER_EMAIL: "organizer@example.test",
      GOOGLE_CLIENT_ID: randomBytes(32).toString("base64url"),
      GOOGLE_CLIENT_SECRET: randomBytes(32).toString("base64url"),
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    const options = convertV4MiniflareOptions({
      ...workerOptions,
      name: "calflare",
      modules,
      bindings,
      host: "127.0.0.1",
      port,
      logRequests: false,
      outboundService: (request) =>
        google.fetch(request).catch((error) => {
          upstreamFailures.push(error.name);
          throw error;
        }),
    });
    options.resourcePersistencePath = join(temporary, "v3");
    mf = new Miniflare(options);
    await mf.ready;
    const db = await mf.getD1Database("DB");
    assert.equal(await db.prepare("SELECT count(*) AS n FROM owner").first("n"), 0);
    const request = (path, init = {}) => fetch(`${origin}${path}`, { ...init, redirect: "manual" });
    const send = (path, value, headers = {}, method = "POST") =>
      request(path, {
        method,
        headers: { Origin: origin, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(value),
      });
    const read = async (response, status = 200) => {
      const text = await response.text();
      assert.equal(response.status, status, `HTTP ${response.status}, expected ${status}`);
      return JSON.parse(text);
    };
    const login = () => loginWithFixture(request, google, read);
    const scheduled = async () => {
      const worker = await mf.getWorker("calflare");
      return worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" });
    };
    return {
      origin,
      db,
      google,
      upstreamFailures,
      request,
      send,
      read,
      login,
      scheduled,
      close,
      temporary,
      settings,
      secrets: {
        GOOGLE_CLIENT_ID: bindings.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: bindings.GOOGLE_CLIENT_SECRET,
        TOKEN_ENCRYPTION_KEY: bindings.TOKEN_ENCRYPTION_KEY,
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function verifyWorker(fixture) {
  const { request, send, read, google } = fixture;
  assert.deepEqual(await read(await request("/api/health")), { status: "ok", storage: "d1" });
  await read(await request("/api/public"), 503);
  const unavailable = await request("/intro");
  assert.equal(unavailable.status, 503);
  assert.ok((await unavailable.text()).includes("This event is temporarily unavailable"));
  await read(await request("/api/owner"), 401);
  const ownerHeaders = await fixture.login();
  await read(await send("/api/owner", settings, ownerHeaders, "PUT"));
  assert.equal(
    (
      await read(
        await send(
          "/api/owner",
          { ...settings, event: { ...settings.event, slug: "api" } },
          ownerHeaders,
          "PUT"
        ),
        400
      )
    ).error,
    "INVALID_SETTINGS"
  );
  assert.deepEqual((await read(await request("/api/owner", { headers: ownerHeaders }))).settings, settings);
  const missing = await request("/missing-event");
  assert.equal(missing.status, 404);
  const publicPage = await request(`/${settings.event.slug}`);
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.headers.get("Cache-Control"), "private, no-store");
  const html = await publicPage.text();
  assert.ok(html.includes(settings.event.title));
  assert.ok(html.includes("astro-island"));
  assert.ok(!html.includes("organizer@example.test"));
  for (const secret of [...Object.values(fixture.secrets), ...google.secrets])
    assert.ok(!html.includes(secret));
  const owner = await read(await request("/api/owner", { headers: ownerHeaders }));
  assert.equal(owner.owner.email, "organizer@example.test");
  assert.deepEqual(owner.settings, settings);
  for (const secret of [
    ...Object.values(fixture.secrets),
    ...google.secrets,
    ownerHeaders.Cookie.split("=")[1],
  ])
    assert.ok(!JSON.stringify(owner).includes(secret));
  const tomorrow = Math.ceil((Date.now() + 24 * hour) / (24 * hour)) * 24 * hour;
  await verifyBookingRules(fixture, ownerHeaders, tomorrow);
  await verifyWeeklySchedule(fixture, ownerHeaders, tomorrow);
  const slotsPath = `/api/slots?${new URLSearchParams({
    from: new Date(tomorrow).toISOString(),
    to: new Date(tomorrow + 24 * hour).toISOString(),
    timeZone: "UTC",
  })}`;
  const slots = await read(await request(slotsPath));
  assert.ok(slots.slots.length >= 8);
  const prefetchTo = tomorrow + 63 * 24 * hour;
  const prefetchPath = (to) =>
    `/api/slots?${new URLSearchParams({ from: new Date(tomorrow).toISOString(), to: new Date(to).toISOString(), timeZone: "UTC" })}`;
  const prefetched = await read(await request(prefetchPath(prefetchTo)));
  assert.equal(prefetched.slots.length, 3_024);
  assert.equal(prefetched.slots[0].start, tomorrow);
  assert.equal(prefetched.slots.at(-1).end, prefetchTo);
  assert.equal((await read(await request(prefetchPath(prefetchTo + 1)), 400)).error, "invalid_range");
  await verifyTokenRefresh(fixture, slotsPath);
  await verifyBookingJourney(fixture, slots, slotsPath);
  await verifyRecovery(fixture, slots);
  await verifyPublicIdentity(fixture);
  assert.deepEqual(fixture.upstreamFailures, [], "upstream fixture failures must not be swallowed");
  return { ownerHeaders };
}

async function verifyBookingRules(fixture, owner, day) {
  const { send, request, read, db, google } = fixture;
  const rules = {
    intervalMinutes: 60,
    beforeMinutes: 15,
    afterMinutes: 20,
    noticeMinutes: 0,
    disableCancelling: true,
    disableRescheduling: false,
  };
  await read(await send("/api/owner/booking-rules", rules, {}, "PATCH"), 401);
  await read(
    await send("/api/owner/booking-rules", rules, { ...owner, Origin: "https://foreign.example" }, "PATCH"),
    403
  );
  await read(
    await send("/api/owner/booking-rules", { ...rules, disableCancelling: "true" }, owner, "PATCH"),
    400
  );
  await read(await send("/api/owner/booking-rules", rules, owner, "PATCH"));
  const expected = { ...settings, event: { ...settings.event, ...rules } };
  assert.deepEqual((await read(await request("/api/owner", { headers: owner }))).settings, expected);
  assert.equal(
    await db.prepare("SELECT json FROM organizer_settings WHERE id='owner'").first("json"),
    JSON.stringify(expected)
  );
  const id = "a".repeat(32);
  google.events.set(id, {
    id,
    etag: '"rules-busy"',
    start: { dateTime: new Date(day + 9 * hour).toISOString() },
    end: { dateTime: new Date(day + 10 * hour).toISOString() },
  });
  const slots = () =>
    request(
      `/api/slots?${new URLSearchParams({ from: new Date(day + 8 * hour).toISOString(), to: new Date(day + 12 * hour).toISOString(), timeZone: "UTC" })}`
    );
  try {
    assert.deepEqual(
      (await read(await slots())).slots,
      [8, 11].map((hours) => ({ start: day + hours * hour, end: day + hours * hour + 30 * 60_000 }))
    );
    await read(await send("/api/owner/booking-rules", { ...rules, noticeMinutes: 43200 }, owner, "PATCH"));
    assert.deepEqual(await read(await slots()), { slots: [] });
    assert.equal(google.writes.length, 0);
  } finally {
    google.events.delete(id);
  }
  await read(await send("/api/owner", settings, owner, "PUT"));
}

async function verifyWeeklySchedule(fixture, owner, day) {
  const { send, request, read, db, google } = fixture;
  const original = {
    ...settings,
    schedule: {
      ...settings.schedule,
      overrides: [{ date: new Date(day + 24 * hour).toISOString().slice(0, 10), ranges: [] }],
    },
  };
  await read(await send("/api/owner", original, owner, "PUT"));
  const weekly = {
    timeZone: "Asia/Kolkata",
    rules: Array.from({ length: 7 }, (_, weekday) => [
      { weekday, startMinute: 540, endMinute: 600 },
      { weekday, startMinute: 630, endMinute: 660 },
    ]).flat(),
  };
  await read(await send("/api/owner/schedule", weekly, {}, "PATCH"), 401);
  await read(
    await send("/api/owner/schedule", weekly, { ...owner, Origin: "https://foreign.example" }, "PATCH"),
    403
  );
  await read(await send("/api/owner/schedule", { ...weekly, timeZone: "Invalid/Zone" }, owner, "PATCH"), 400);
  await read(await send("/api/owner/schedule", weekly, owner, "PATCH"));
  const expected = { ...original, schedule: { ...original.schedule, ...weekly } };
  assert.deepEqual((await read(await request("/api/owner", { headers: owner }))).settings, expected);
  assert.equal(
    await db.prepare("SELECT json FROM organizer_settings WHERE id='owner'").first("json"),
    JSON.stringify(expected)
  );
  const slots = (from) =>
    request(
      `/api/slots?${new URLSearchParams({
        from: new Date(from).toISOString(),
        to: new Date(from + 24 * hour).toISOString(),
        timeZone: "UTC",
      })}`
    );
  const result = await read(await slots(day));
  assert.deepEqual(
    result.slots,
    [210, 240, 300].map((minute) => ({ start: day + minute * 60_000, end: day + (minute + 30) * 60_000 }))
  );
  assert.deepEqual(
    await read(await slots(day + 24 * hour)),
    { slots: [] },
    "Preserved dated closures override the changed weekly hours"
  );
  const overrides = [
    { date: new Date(day).toISOString().slice(0, 10), ranges: [{ startMinute: 660, endMinute: 720 }] },
    ...original.schedule.overrides,
  ];
  await read(await send("/api/owner/overrides", { overrides }, {}, "PATCH"), 401);
  await read(
    await send(
      "/api/owner/overrides",
      { overrides },
      {
        ...owner,
        Origin: "https://foreign.example",
      },
      "PATCH"
    ),
    403
  );
  await read(
    await send(
      "/api/owner/overrides",
      {
        overrides: [{ date: "2030-02-29", ranges: [] }],
      },
      owner,
      "PATCH"
    ),
    400
  );
  await read(await send("/api/owner/overrides", { overrides }, owner, "PATCH"));
  const overridden = { ...expected, schedule: { ...expected.schedule, overrides } };
  assert.deepEqual((await read(await request("/api/owner", { headers: owner }))).settings, overridden);
  assert.equal(
    await db.prepare("SELECT json FROM organizer_settings WHERE id='owner'").first("json"),
    JSON.stringify(overridden)
  );
  assert.deepEqual(
    (await read(await slots(day))).slots,
    [330, 360].map((minute) => ({ start: day + minute * 60_000, end: day + (minute + 30) * 60_000 }))
  );
  assert.deepEqual(await read(await slots(day + 24 * hour)), { slots: [] });
  await read(await send("/api/owner/overrides", { overrides: [] }, owner, "PATCH"));
  assert.deepEqual(
    (await read(await slots(day + 24 * hour))).slots,
    [210, 240, 300].map((minute) => ({
      start: day + 24 * hour + minute * 60_000,
      end: day + 24 * hour + (minute + 30) * 60_000,
    }))
  );
  await read(await send("/api/owner/schedule", { timeZone: "UTC", rules: [] }, owner, "PATCH"));
  assert.deepEqual(await read(await slots(day)), { slots: [] });
  assert.equal(google.writes.length, 0);
  await read(await send("/api/owner", settings, owner, "PUT"));
}

async function verifyPublicIdentity(fixture) {
  const original = fixture.google.fetch;
  fixture.google.fetch = async (request) => {
    const response = await original(request);
    if (new URL(request.url).pathname !== "/v1/userinfo") return response;
    const identity = await response.json();
    delete identity.name;
    return Response.json(identity);
  };
  try {
    await fixture.login();
  } finally {
    fixture.google.fetch = original;
  }
  assert.equal(
    await fixture.db.prepare("SELECT name FROM owner WHERE id='owner'").first("name"),
    "organizer@example.test"
  );
  for (const name of [
    "organizer@example.test",
    " ORGANIZER@EXAMPLE.TEST ",
    "Host organizer@example.test",
    "",
  ]) {
    await fixture.db.prepare("UPDATE owner SET name=? WHERE id='owner'").bind(name).run();
    const data = await fixture.read(await fixture.request("/api/public"));
    assert.equal(data.organizer.name, "Organizer");
    const page = await fixture.request(`/${settings.event.slug}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(!html.toLowerCase().includes("organizer@example.test"));
    assert.ok(html.includes("Organizer"));
  }
}

async function verifyTokenRefresh(fixture, slotsPath) {
  const { db, request, read, google } = fixture;
  const key = await encryptionKey(fixture.secrets.TOKEN_ENCRYPTION_KEY);
  const before = await db
    .prepare("SELECT ciphertext,version FROM google_connection WHERE owner_id='owner'")
    .first();
  const tokens = JSON.parse(await unseal(key, before.ciphertext, "google:owner"));
  assert.deepEqual(google.grants, ["authorization_code"]);
  await db
    .prepare("UPDATE google_connection SET ciphertext=?,version=version+1 WHERE owner_id='owner'")
    .bind(await seal(key, JSON.stringify({ ...tokens, expiresAt: 0 }), "google:owner"))
    .run();
  assert.ok((await read(await request(slotsPath))).slots.length > 0);
  const after = await db
    .prepare("SELECT ciphertext,version FROM google_connection WHERE owner_id='owner'")
    .first();
  const refreshed = JSON.parse(await unseal(key, after.ciphertext, "google:owner"));
  assert.equal(after.version, before.version + 2);
  assert.ok(refreshed.expiresAt > Date.now() + 3_500_000);
  assert.equal(refreshed.refresh, tokens.refresh);
  for (const token of [refreshed.access, refreshed.refresh]) assert.ok(!after.ciphertext.includes(token));
  assert.ok((await read(await request(slotsPath))).slots.length > 0);
  assert.deepEqual(google.grants, ["authorization_code", "refresh_token"]);
}

async function verifyBookingJourney(fixture, slots, slotsPath) {
  const { request, send, read, db, google } = fixture;
  const value = input(slots.slots[0].start);
  await read(await send("/api/bookings", value, { Origin: "https://foreign.example" }), 403);
  const booking = await read(await send("/api/bookings", value), 201);
  assert.equal(booking.status, "confirmed");
  const replay = await read(await send("/api/bookings", value), 201);
  assert.equal(replay.id, booking.id);
  assert.equal(google.writes.length, 1);
  const event = google.events.get(booking.id);
  assert.equal(event.attendees[0].email, value.email);
  assert.equal(Date.parse(event.start.dateTime), value.start);
  await read(await request(`/api/bookings/${booking.id}`), 401);
  await read(
    await request(`/api/bookings/${booking.id}`, { headers: { Authorization: `Bearer ${"A".repeat(43)}` } }),
    404
  );
  const view = await read(await request(`/api/bookings/${booking.id}`, { headers: auth(booking) }));
  const stored = await db
    .prepare("SELECT token_hash FROM booking WHERE id=?")
    .bind(booking.id)
    .first("token_hash");
  assert.notEqual(stored, booking.manageToken);
  for (const secret of [booking.manageToken, stored, ...google.secrets])
    assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(
    (await read(await request(slotsPath))).slots.some((slot) => slot.start === value.start),
    false
  );
  const moved = await read(
    await send(
      `/api/bookings/${booking.id}`,
      {
        action: "reschedule",
        version: view.version,
        requestKey: randomBytes(18).toString("hex"),
        start: slots.slots[3].start,
      },
      auth(booking)
    )
  );
  assert.equal(moved.id, booking.id);
  assert.equal(moved.start, slots.slots[3].start);
  assert.equal(Date.parse(google.events.get(booking.id).start.dateTime), moved.start);
  const cancelled = await read(
    await send(
      `/api/bookings/${booking.id}`,
      { action: "cancel", version: moved.version, requestKey: randomBytes(18).toString("hex") },
      auth(booking)
    )
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.id, booking.id);
  assert.equal(google.events.size, 0);
  assert.deepEqual(
    google.writes.map((write) => [write.action, write.id]),
    [
      ["insert", booking.id],
      ["update", booking.id],
      ["delete", booking.id],
    ]
  );
  const race = await Promise.all([
    send("/api/bookings", input(slots.slots[5].start)),
    send("/api/bookings", input(slots.slots[5].start)),
  ]);
  assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
  await Promise.all(race.map((response) => response.arrayBuffer()));
  assert.equal(google.events.size, 1);
}

async function verifyRecovery(fixture, slots) {
  const { request, send, read, db, google } = fixture;
  google.loseResponseAfter("insert");
  const pending = await read(await send("/api/bookings", input(slots.slots[7].start)), 202);
  const inserts = google.writes.filter((write) => write.action === "insert").length;
  assert.ok(google.events.has(pending.id), "provider applied before response was lost");
  const before = await db.prepare("SELECT state,pending_id FROM booking WHERE id=?").bind(pending.id).first();
  assert.equal(before.state, "unconfirmed");
  assert.ok(before.pending_id);
  // Move the durable retry deadline instead of waiting a minute or changing the production clock.
  const recover = async (id) => {
    await db
      .prepare("UPDATE booking_command SET due=0,lease_until=0 WHERE booking_id=? AND terminal=0")
      .bind(id)
      .run();
    await fixture.scheduled();
  };
  await recover(pending.id);
  const recovered = await db
    .prepare("SELECT state,pending_id FROM booking WHERE id=?")
    .bind(pending.id)
    .first();
  assert.deepEqual(recovered, { state: "active", pending_id: null });
  assert.equal(google.writes.filter((write) => write.action === "insert").length, inserts);
  const recoveredView = await read(await request(`/api/bookings/${pending.id}`, { headers: auth(pending) }));
  assert.equal(recoveredView.status, "confirmed");
  for (const { action, command, state, extra } of [
    { action: "update", command: "reschedule", state: "active", extra: { start: slots.slots[9].start } },
    { action: "delete", command: "cancel", state: "cancelled", extra: {} },
  ]) {
    google.loseResponseAfter(action);
    const current = await read(await request(`/api/bookings/${pending.id}`, { headers: auth(pending) }));
    await read(
      await send(
        `/api/bookings/${pending.id}`,
        {
          action: command,
          version: current.version,
          requestKey: randomBytes(18).toString("hex"),
          ...extra,
        },
        auth(pending)
      ),
      202
    );
    const writes = google.writes.length;
    await recover(pending.id);
    const result = await db
      .prepare("SELECT state,pending_id FROM booking WHERE id=?")
      .bind(pending.id)
      .first();
    assert.deepEqual(result, { state, pending_id: null });
    assert.equal(
      google.writes.length,
      writes,
      "scheduled reconciliation must not repeat a provider-applied write"
    );
  }
  assert.deepEqual(google.denied, []);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const fixture = await createWorkerFixture();
  try {
    await verifyWorker(fixture);
    process.stdout.write(
      "Local built Worker/workerd/D1 proof passed. Google is mocked; deployed behavior and live Google remain unverified.\n"
    );
  } finally {
    await fixture.close();
  }
}

export { createWorkerFixture, verifyWorker };
