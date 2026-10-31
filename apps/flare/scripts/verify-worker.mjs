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
import { hour, settings as httpSettings, storedSettings } from "./fixtures/api.ts";
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
    for (const name of [
      "0001_identity.sql",
      "0002_settings.sql",
      "0003_bookings.sql",
      "0004_http.sql",
      "0005_events.sql",
      "0006_event_lifecycle.sql",
      "0007_availability_schedules.sql",
    ]) {
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
  await verifyBookingJourney(fixture, slots, slotsPath, ownerHeaders);
  await verifyRecovery(fixture, slots, ownerHeaders);
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
  assert.equal((await storedSettings(db))?.json, JSON.stringify(expected));
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
  assert.equal((await storedSettings(db))?.json, JSON.stringify(expected));
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
  assert.equal((await storedSettings(db))?.json, JSON.stringify(overridden));
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

async function verifyBookingJourney(fixture, slots, slotsPath, owner) {
  const { request, send, read, db, google } = fixture;
  const notes = "First line\nSecond line <plain> & text\nThird line 😀";
  const guests = [
    "Z@example.com",
    ...Array.from({ length: 21 }, (_, i) => `g${i}@example.com`),
    "guest@example.test",
  ];
  const normalized = guests.map((email) => email.toLowerCase());
  const value = { ...input(slots.slots[0].start), notes: ` \n${notes}\t `, guests };
  const commands = await db.prepare("SELECT count(*) AS n FROM booking_command").first("n");
  const writes = google.writes.length;
  for (const invalid of [null, 1, false, [], {}, "x".repeat(1001), `${"😀".repeat(500)}x`])
    assert.equal(
      (await read(await send("/api/bookings", { ...value, notes: invalid }), 400)).error,
      "invalid_input"
    );
  for (const guests of [
    null,
    "a@example.com",
    {},
    [1],
    ["", "a@example.com"],
    [" "],
    ["A@example.com", "a@example.com"],
  ])
    assert.equal((await read(await send("/api/bookings", { ...value, guests }), 400)).error, "invalid_input");
  assert.equal(
    (
      await read(
        await send("/api/bookings", {
          ...value,
          guests: Array.from({ length: 2000 }, (_, i) => `g${i}@example.com`),
        }),
        413
      )
    ).error,
    "request_too_large"
  );
  assert.equal(await db.prepare("SELECT count(*) AS n FROM booking_command").first("n"), commands);
  assert.equal(google.writes.length, writes);
  await read(await send("/api/bookings", value, { Origin: "https://foreign.example" }), 403);
  const booking = await read(await send("/api/bookings", value), 201);
  assert.equal(booking.status, "confirmed");
  const replay = await read(await send("/api/bookings", { ...value, notes, guests: normalized }), 201);
  assert.equal(replay.id, booking.id);
  assert.equal(
    (await read(await send("/api/bookings", { ...value, notes: `${notes}!` }), 409)).error,
    "idempotency_mismatch"
  );
  for (const guests of [[...normalized].reverse(), ["different@example.com"]])
    assert.equal(
      (await read(await send("/api/bookings", { ...value, guests }), 409)).error,
      "idempotency_mismatch"
    );
  assert.equal(google.writes.length, 1);
  const event = google.events.get(booking.id);
  const description =
    "Meet the organizer\n\nAdditional notes:\nFirst line\nSecond line <plain> & text\nThird line 😀";
  assert.equal(event.description, description);
  assert.equal(event.attendees[0].email, value.email);
  assert.deepEqual(event.attendees, [
    { email: value.email, displayName: value.name },
    ...normalized.slice(0, -1).map((email) => ({ email })),
  ]);
  const persisted = await db
    .prepare("SELECT initial_json,confirmed_json FROM booking WHERE id=?")
    .bind(booking.id)
    .first();
  for (const json of Object.values(persisted)) assert.deepEqual(JSON.parse(json).guests, normalized);
  assert.equal(Date.parse(event.start.dateTime), value.start);
  await read(await request(`/api/bookings/${booking.id}`), 401);
  await read(
    await request(`/api/bookings/${booking.id}`, { headers: { Authorization: `Bearer ${"A".repeat(43)}` } }),
    404
  );
  const view = await read(await request(`/api/bookings/${booking.id}`, { headers: auth(booking) }));
  const ownerData = await read(await request("/api/owner", { headers: owner }));
  for (const projection of [
    booking,
    replay,
    view,
    ownerData,
    await read(await request("/api/public")),
    await read(await request(slotsPath)),
  ]) {
    assert.ok(!JSON.stringify(projection).includes("First line"));
    for (const email of normalized.filter((email) => email !== value.email))
      assert.ok(!JSON.stringify(projection).includes(email));
    assert.ok(!Object.hasOwn(projection, "guests"));
  }
  for (const projection of [booking, view, ...ownerData.bookings]) {
    assert.ok(!Object.hasOwn(projection, "notes"));
    assert.ok(!Object.hasOwn(projection, "description"));
    assert.ok(!Object.hasOwn(projection, "guests"));
  }
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
  const rescheduleReason = "Need to move\r\n\n é 😀 <literal>",
    moveKey = randomBytes(18).toString("hex");
  const move = {
    action: "reschedule",
    version: view.version,
    requestKey: moveKey,
    start: slots.slots[3].start,
    rescheduleReason,
  };
  const project = async (key, expected) => {
    const privateView = await read(await request(`/api/bookings/${booking.id}`, { headers: auth(booking) }));
    const ownerView = (await read(await request("/api/owner", { headers: owner }))).bookings.find(
      (row) => row.id === booking.id
    );
    assert.ok(ownerView);
    for (const projection of [privateView, ownerView]) {
      assert.equal(projection[key], expected);
      assert.equal(Object.hasOwn(projection, key), expected !== undefined);
      assert.ok(!JSON.stringify(projection).includes("Rejected private reason"));
    }
  };
  const completedOnly = async (command, key, reason) => {
    await project(key, reason);
    for (const [execution, version] of [
      ["queued", command.accepted_version],
      ["sent", command.accepted_version],
      ["done", command.accepted_version - 1],
      ["done", command.accepted_version],
    ]) {
      await db
        .prepare("UPDATE booking_command SET execution=?,accepted_version=? WHERE id=?")
        .bind(execution, version, command.id)
        .run();
      await project(key, execution === "done" && version === command.accepted_version ? reason : undefined);
    }
  };
  const moved = await read(
    await send(
      `/api/bookings/${booking.id}`,
      { ...move, rescheduleReason: ` \n${rescheduleReason}\t ` },
      auth(booking)
    )
  );
  assert.equal(moved.id, booking.id);
  assert.equal(moved.start, slots.slots[3].start);
  assert.equal(moved.rescheduleReason, rescheduleReason);
  const moveCommand = await db
    .prepare("SELECT * FROM booking_command WHERE request_key=?")
    .bind(moveKey)
    .first();
  assert.equal(
    moveCommand.payload,
    `{"action":"reschedule","id":"${booking.id}","requestKey":"${moveKey}","version":${view.version},"start":${moved.start},"rescheduleReason":${JSON.stringify(rescheduleReason)}}`
  );
  assert.deepEqual(JSON.parse(moveCommand.desired_json), {
    ...JSON.parse(persisted.confirmed_json),
    start: moved.start,
    end: moved.end,
    privateMetadata: { ...JSON.parse(persisted.confirmed_json).privateMetadata, operation: moveCommand.id },
  });
  assert.equal(
    (
      await read(
        await send(`/api/bookings/${booking.id}`, { ...move, rescheduleReason: "Changed" }, auth(booking)),
        409
      )
    ).error,
    "idempotency_mismatch"
  );
  assert.deepEqual(
    await db.prepare("SELECT * FROM booking_command WHERE request_key=?").bind(moveKey).first(),
    moveCommand
  );
  await completedOnly(moveCommand, "rescheduleReason", rescheduleReason);
  assert.equal(Date.parse(google.events.get(booking.id).start.dateTime), moved.start);
  assert.equal(google.events.get(booking.id).description, description);
  assert.doesNotMatch(JSON.stringify(google.events.get(booking.id)), /rescheduleReason|Need to move/);
  assert.deepEqual(google.events.get(booking.id).attendees, event.attendees);
  assert.equal(
    await db
      .prepare("SELECT confirmed_json FROM booking WHERE id=?")
      .bind(booking.id)
      .first("confirmed_json"),
    moveCommand.desired_json
  );
  const cancellationReason = "Need to cancel\n\nFamily <literal> & plans\r\n é 😀";
  const cancellation = {
    action: "cancel",
    version: moved.version,
    requestKey: randomBytes(18).toString("hex"),
    cancellationReason,
  };
  const confirmed = await db
    .prepare("SELECT confirmed_json FROM booking WHERE id=?")
    .bind(booking.id)
    .first("confirmed_json");
  const beforeCancel = google.fetch;
  let deletes = 0;
  google.fetch = async (request) => {
    if (request.method === "DELETE") {
      deletes++;
      assert.equal(await request.clone().text(), "");
      assert.equal(new URL(request.url).searchParams.get("sendUpdates"), "all");
      assert.ok(request.headers.get("If-Match"));
      assert.ok(!request.url.includes("cancellationReason"));
    }
    return beforeCancel(request);
  };
  for (const cancellationReason of [null, 1, [], {}, "x".repeat(1001)])
    assert.equal(
      (
        await read(
          await send(`/api/bookings/${booking.id}`, { ...cancellation, cancellationReason }, auth(booking)),
          400
        )
      ).error,
      "invalid_input"
    );
  const rejected = {
    ...cancellation,
    version: moved.version - 1,
    requestKey: randomBytes(18).toString("hex"),
    cancellationReason: "Rejected private reason",
  };
  assert.equal(
    (await read(await send(`/api/bookings/${booking.id}`, rejected, auth(booking)), 409)).error,
    "stale"
  );
  await project("rescheduleReason", rescheduleReason);
  const cancelled = await read(
    await send(
      `/api/bookings/${booking.id}`,
      { ...cancellation, cancellationReason: ` \n${cancellationReason}\t ` },
      auth(booking)
    )
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.id, booking.id);
  await project("rescheduleReason", undefined);
  assert.ok(
    !Object.hasOwn(
      await read(await send(`/api/bookings/${booking.id}`, move, auth(booking))),
      "rescheduleReason"
    )
  );
  assert.equal(cancelled.cancellationReason, cancellationReason);
  assert.equal(
    (await read(await send(`/api/bookings/${booking.id}`, cancellation, auth(booking)))).cancellationReason,
    cancellationReason
  );
  const command = await db
    .prepare("SELECT * FROM booking_command WHERE request_key=?")
    .bind(cancellation.requestKey)
    .first();
  assert.equal(
    command.payload,
    JSON.stringify({
      action: "cancel",
      id: booking.id,
      requestKey: cancellation.requestKey,
      version: moved.version,
      cancellationReason,
    })
  );
  assert.equal(command.terminal, 1);
  assert.equal(command.execution, "done");
  const storedCancellation = await db
    .prepare("SELECT confirmed_json,pending_id FROM booking WHERE id=?")
    .bind(booking.id)
    .first();
  assert.deepEqual(storedCancellation, { confirmed_json: confirmed, pending_id: null });
  assert.ok(!command.desired_json.includes("Need to cancel"));
  assert.ok(!Object.hasOwn(JSON.parse(command.desired_json), "cancellationReason"));
  const original = JSON.parse(confirmed);
  assert.deepEqual(JSON.parse(command.desired_json), {
    ...original,
    privateMetadata: { ...original.privateMetadata, operation: command.id },
  });
  assert.equal(
    (
      await read(
        await send(
          `/api/bookings/${booking.id}`,
          { ...cancellation, cancellationReason: "Changed" },
          auth(booking)
        ),
        409
      )
    ).error,
    "idempotency_mismatch"
  );
  assert.deepEqual(
    await db
      .prepare("SELECT * FROM booking_command WHERE request_key=?")
      .bind(cancellation.requestKey)
      .first(),
    command
  );
  await completedOnly(command, "cancellationReason", cancellationReason);
  for (const [path, headers, status] of [
    [`/api/bookings/${booking.id}`, {}, 401],
    [`/api/bookings/${booking.id}`, { Authorization: `Bearer ${"A".repeat(43)}` }, 404],
    ["/api/owner", {}, 401],
    ["/api/public", {}, 200],
    [slotsPath, {}, 200],
  ]) {
    const value = await read(await request(path, { headers }), status);
    assert.ok(!JSON.stringify(value).includes("Need to cancel"));
    assert.ok(!Object.hasOwn(value, "cancellationReason"));
    assert.ok(!JSON.stringify(value).includes("Need to move"));
    assert.ok(!Object.hasOwn(value, "rescheduleReason"));
  }
  assert.equal(deletes, 1);
  google.fetch = beforeCancel;
  assert.equal(google.events.size, 0);
  assert.deepEqual(
    google.writes.map((write) => [write.action, write.id]),
    [
      ["insert", booking.id],
      ["update", booking.id],
      ["delete", booking.id],
    ]
  );
  const rivals = [input(slots.slots[5].start), input(slots.slots[5].start)];
  const race = await Promise.all(rivals.map((value) => send("/api/bookings", value)));
  assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
  const winner = rivals[race.findIndex((response) => response.status === 201)];
  await Promise.all(race.map((response) => response.arrayBuffer()));
  const legacy = await read(await send("/api/bookings", { ...winner, notes: " \n ", guests: ["", ""] }), 201);
  assert.equal((await read(await send("/api/bookings", { ...winner, notes: "" }), 201)).id, legacy.id);
  assert.equal(google.events.get(legacy.id).description, "Meet the organizer");
  assert.equal(google.events.size, 1);
  const legacyCancel = {
    action: "cancel",
    requestKey: randomBytes(18).toString("hex"),
    version: legacy.version,
  };
  const legacyResult = await read(await send(`/api/bookings/${legacy.id}`, legacyCancel, auth(legacy)));
  assert.ok(!Object.hasOwn(legacyResult, "cancellationReason"));
  for (const cancellationReason of ["", " \n\t "])
    assert.deepEqual(
      await read(
        await send(`/api/bookings/${legacy.id}`, { ...legacyCancel, cancellationReason }, auth(legacy))
      ),
      legacyResult
    );
  assert.equal(
    await db
      .prepare("SELECT payload FROM booking_command WHERE request_key=?")
      .bind(legacyCancel.requestKey)
      .first("payload"),
    JSON.stringify({
      action: "cancel",
      id: legacy.id,
      requestKey: legacyCancel.requestKey,
      version: legacy.version,
    })
  );
}

async function verifyRecovery(fixture, slots, owner) {
  const { request, send, read, db, google } = fixture;
  await read(
    await send("/api/owner", { ...settings, event: { ...settings.event, description: "" } }, owner, "PUT")
  );
  google.loseResponseAfter("insert");
  const pending = await read(
    await send("/api/bookings", {
      ...input(slots.slots[7].start),
      notes: "Recovery <notes>\nSame invitation",
      guests: ["recovery@example.com", "guest@example.test"],
    }),
    202
  );
  const remote = google.events.get(pending.id);
  assert.equal(remote.description, "Additional notes:\nRecovery <notes>\nSame invitation");
  await read(await send("/api/owner", settings, owner, "PUT"));
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
  for (const change of [
    { description: "Changed remotely" },
    { attendees: remote.attendees.slice(0, 1) },
    { attendees: [remote.attendees[0], { email: "substitute@example.com" }] },
    { attendees: [...remote.attendees, { email: "extra@example.com", self: true, organizer: true }] },
  ]) {
    google.events.set(pending.id, { ...remote, ...change });
    await recover(pending.id);
    const mismatch = await read(await request(`/api/bookings/${pending.id}`, { headers: auth(pending) }));
    assert.equal(mismatch.status, "attention");
    assert.equal(mismatch.error, "event_mismatch");
    assert.equal(google.writes.filter((write) => write.action === "insert").length, inserts);
  }
  google.events.set(pending.id, remote);
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
    {
      action: "update",
      command: "reschedule",
      state: "active",
      extra: { start: slots.slots[9].start, rescheduleReason: "Recovery <move>\r\nPreserved 😀" },
    },
    { action: "update", command: "reschedule", state: "active", extra: { start: slots.slots[11].start } },
    {
      action: "delete",
      command: "cancel",
      state: "cancelled",
      extra: { cancellationReason: "Recovery <reason>\r\nPreserved 😀" },
    },
  ]) {
    const current = await read(await request(`/api/bookings/${pending.id}`, { headers: auth(pending) }));
    const base = google.events.get(pending.id),
      beforeWrites = google.writes.length;
    google.events.set(pending.id, {
      ...base,
      attendees: [...base.attendees, { email: "extra@example.com", self: true }],
    });
    const blocked = await read(
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
    assert.equal(blocked.error, "event_changed");
    assert.ok(!Object.hasOwn(blocked, "cancellationReason"));
    assert.ok(!Object.hasOwn(blocked, "rescheduleReason"));
    const blockedOwner = (await read(await request("/api/owner", { headers: owner }))).bookings.find(
      (row) => row.id === pending.id
    );
    assert.ok(!Object.hasOwn(blockedOwner, "cancellationReason"));
    assert.ok(!Object.hasOwn(blockedOwner, "rescheduleReason"));
    assert.equal(google.writes.length, beforeWrites);
    google.events.set(pending.id, base);
    google.loseResponseAfter(action);
    const uncertain = await read(await send(`/api/bookings/${pending.id}/retry`, {}, auth(pending)), 202);
    assert.ok(!Object.hasOwn(uncertain, "cancellationReason"));
    assert.ok(!Object.hasOwn(uncertain, "rescheduleReason"));
    await read(
      await send(
        "/api/owner",
        { ...settings, event: { ...settings.event, title: "Changed", durationMinutes: 60 } },
        owner,
        "PUT"
      )
    );
    const writes = google.writes.length;
    await recover(pending.id);
    const result = await db
      .prepare("SELECT state,pending_id FROM booking WHERE id=?")
      .bind(pending.id)
      .first();
    assert.deepEqual(result, { state, pending_id: null });
    const terminal = await read(await request(`/api/bookings/${pending.id}`, { headers: auth(pending) }));
    assert.equal(terminal.cancellationReason, extra.cancellationReason);
    assert.equal(terminal.rescheduleReason, extra.rescheduleReason);
    const ownerProjection = (await read(await request("/api/owner", { headers: owner }))).bookings.find(
      (row) => row.id === pending.id
    );
    assert.equal(ownerProjection.rescheduleReason, extra.rescheduleReason);
    assert.equal(ownerProjection.cancellationReason, extra.cancellationReason);
    await read(await send("/api/owner", settings, owner, "PUT"));
    if (action === "delete") {
      assert.equal(
        (await read(await send(`/api/bookings/${pending.id}/retry`, {}, auth(pending)))).cancellationReason,
        extra.cancellationReason
      );
    }
    if (action === "update") {
      assert.equal(google.events.get(pending.id).description, remote.description);
      assert.deepEqual(google.events.get(pending.id).attendees, remote.attendees);
    }
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
