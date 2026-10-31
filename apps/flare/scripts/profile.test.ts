import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient } from "../src/client/bookings.ts";
import { canonicalProfile, parseProfile } from "../src/domain/profile.ts";
import { getOwnerProfile, getPublicDirectory } from "../src/server/app.ts";
import { BookingService } from "../src/server/bookings.ts";
import { apiFixture, hour, storedSettings } from "./fixtures/api.ts";

const profile = { displayName: "東京 <public>", bio: "  <script>literal</script>\n**plain** 😀  " };

test("profile text has explicit bounds, literal biography and a canonical nullable name", () => {
  assert.deepEqual(parseProfile({ ...profile, displayName: "  東京 <public>  " }), profile);
  for (const displayName of [null, "", " \t\n "]) {
    assert.deepEqual(parseProfile({ displayName, bio: "" }), { displayName: null, bio: "" });
  }
  assert.deepEqual(parseProfile({ displayName: ` ${"x".repeat(100)} `, bio: "😀".repeat(1000) }), {
    displayName: "x".repeat(100),
    bio: "😀".repeat(1000),
  });
  for (const input of [
    null,
    [],
    {},
    { ...profile, extra: true },
    { ...profile, displayName: 3 },
    { ...profile, displayName: "x".repeat(101) },
    { ...profile, bio: null },
    { ...profile, bio: "😀".repeat(1001) },
  ])
    assert.throws(() => parseProfile(input));
  for (const displayName of ["", " padded "])
    assert.throws(() => canonicalProfile({ ...profile, displayName }));
});

test("private profile transport accepts only canonical 200 responses and exact save acknowledgments", async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new BookerClient(async (path, init) => {
    calls.push({ path, init });
    return Response.json(init.method === "PUT" ? { saved: true } : profile);
  });
  assert.deepEqual(await client.ownerProfile(), profile);
  await client.ownerSaveProfile(profile);
  assert.equal(calls[1].path, "/api/owner/profile");
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), profile);
  assert.equal(calls[1].init.credentials, "same-origin");
  assert.equal(calls[1].init.cache, "no-store");
  assert.equal(calls[1].init.redirect, "error");
  for (const value of [null, {}, { saved: false }, { saved: 1 }, { saved: true, extra: true }]) {
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerSaveProfile(profile),
      /invalid_response/
    );
  }
  for (const status of [201, 202, 503]) {
    const invalid = new BookerClient(async () => Response.json({ saved: true }, { status }));
    await assert.rejects(invalid.ownerSaveProfile(profile));
    await assert.rejects(new BookerClient(async () => Response.json(profile, { status })).ownerProfile());
  }
  await assert.rejects(
    new BookerClient(async () => new Response("broken")).ownerSaveProfile(profile),
    /invalid_response/
  );
  for (const value of [
    null,
    {},
    { ...profile, extra: true },
    { ...profile, bio: null },
    { ...profile, displayName: " padded " },
  ]) {
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerProfile(),
      /invalid_response/
    );
  }
});

async function frozenRows(f: Awaited<ReturnType<typeof apiFixture>>) {
  const tables = [
    "owner",
    "google_connection",
    "owner_session",
    "oauth_attempt",
    "organizer_settings",
    "availability_schedule",
    "event_type",
    "booking",
    "booking_command",
    "booking_reservation",
    "http_attempt",
    "http_rate",
  ];
  return Promise.all(
    tables.map((table) =>
      f.db
        .prepare(`SELECT rowid AS cursor,* FROM ${table} ORDER BY rowid`)
        .all()
        .then(({ results }) => results)
    )
  );
}

test("authenticated profile replacement publishes only identity and preserves booking facts, provenance and provider writes", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const get = () => f.request("/api/owner/profile", { headers: f.ownerHeaders });
  const save = (input: unknown) => f.send("/api/owner/profile", input, f.ownerHeaders, "PUT");
  assert.deepEqual(await (await get()).json(), { displayName: null, bio: "" });
  const request = {
    requestKey: "profile-historical-booking-0001",
    start: f.now() + 9 * hour,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  };
  const booking = await (await f.send("/api/bookings", request)).json();
  assert.equal(booking.status, "confirmed");
  const before = await frozenRows(f);
  const originalSettings = await storedSettings(f.db);
  const writes = structuredClone(f.calendar.writes);
  const response = await save({ ...profile, displayName: "  東京 <public>  " });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { saved: true });
  assert.deepEqual(await (await get()).json(), profile);
  assert.deepEqual(await save(profile).then((r) => r.json()), { saved: true });
  assert.deepEqual(await frozenRows(f), before);
  assert.deepEqual(await storedSettings(f.db), originalSettings);
  const metadata = await (await f.request("/api/events/default")).json();
  assert.deepEqual(metadata.organizer, { name: profile.displayName });
  assert.equal(JSON.stringify(metadata).includes(profile.bio), false);
  const directory = await getPublicDirectory(f.env);
  assert.deepEqual(directory.organizer, { name: profile.displayName, bio: profile.bio });
  for (const secret of [f.env.GOOGLE_OWNER_EMAIL, "fixture-google-subject", f.ciphertext, f.session]) {
    assert.ok(!JSON.stringify(directory).includes(secret));
    assert.ok(!JSON.stringify(metadata).includes(secret));
  }
  assert.deepEqual(await (await f.send("/api/bookings", request)).json(), booking);
  assert.deepEqual(f.calendar.writes, writes);
  await f.db.prepare("UPDATE owner SET name='Reauthorized Google name'").run();
  assert.equal((await getPublicDirectory(f.env)).organizer.name, profile.displayName);
  await save({ displayName: null, bio: "" });
  assert.equal((await getPublicDirectory(f.env)).organizer.name, "Reauthorized Google name");
  for (const name of ["", "owner@example.test", "Name OWNER@example.test"]) {
    await f.db.prepare("UPDATE owner SET name=?").bind(name).run();
    assert.equal((await getPublicDirectory(f.env)).organizer.name, "Organizer");
  }
  await save({ displayName: "", bio: "" });
  assert.deepEqual(await (await get()).json(), { displayName: null, bio: "" });
  await f.request("/api/owner/events/default", {
    method: "DELETE",
    headers: { ...f.ownerHeaders, Origin: f.env.PUBLIC_ORIGIN },
  });
  assert.equal((await get()).status, 200);
  assert.equal((await save(profile)).status, 200);
  assert.deepEqual((await getPublicDirectory(f.env)).events, []);
  assert.deepEqual(await (await get()).json(), profile);
});

test("profile authenticates before parsing, rejects extra input, and fails closed on corrupt storage", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  for (const method of ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await f.request("/api/owner/profile?bad=1", {
      method,
      headers: { Origin: "https://foreign.test" },
      ...(["GET", "OPTIONS"].includes(method) ? {} : { body: "broken" }),
    });
    assert.equal(response.status, 401);
  }
  assert.equal(
    (
      await f.send(
        "/api/owner/profile?bad=1",
        null,
        { ...f.ownerHeaders, Origin: "https://foreign.test" },
        "PUT"
      )
    ).status,
    403
  );
  for (const method of ["GET", "PUT"]) {
    assert.equal(
      (
        await f.request("/api/owner/profile?bad=1", {
          method,
          headers: { ...f.ownerHeaders, Origin: f.env.PUBLIC_ORIGIN },
        })
      ).status,
      400
    );
  }
  for (const method of ["PATCH", "POST", "DELETE", "OPTIONS"]) {
    assert.equal(
      (
        await f.request("/api/owner/profile", {
          method,
          headers: { ...f.ownerHeaders, Origin: f.env.PUBLIC_ORIGIN },
        })
      ).status,
      404
    );
  }
  for (const input of [
    {},
    { displayName: null },
    { ...profile, email: "private" },
    { ...profile, bio: null },
    { ...profile, displayName: 1 },
    { ...profile, displayName: "x".repeat(101) },
    { ...profile, bio: "x".repeat(2001) },
  ]) {
    assert.equal((await f.send("/api/owner/profile", input, f.ownerHeaders, "PUT")).status, 400);
  }
  assert.equal(await f.db.prepare("SELECT count(*) AS n FROM organizer_profile").first("n"), 0);
  const raw = (headers: Record<string, string>, body = "broken") =>
    f.request("/api/owner/profile", {
      method: "PUT",
      headers: { ...f.ownerHeaders, Origin: f.env.PUBLIC_ORIGIN, ...headers },
      body,
    });
  assert.equal((await raw({})).status, 415);
  assert.equal((await raw({ "Content-Type": "application/json" })).status, 400);
  assert.equal((await raw({ "Content-Type": "application/json" }, "x".repeat(32769))).status, 413);
  await f.db.prepare("INSERT INTO organizer_profile VALUES ('owner',' padded ','private-corruption')").run();
  for (const path of ["/api/owner/profile", "/api/public", "/api/events/default"]) {
    const response = await f.request(path, { headers: f.ownerHeaders });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private-corruption"));
  }
  assert.equal((await f.send("/api/owner/profile", profile, f.ownerHeaders, "PUT")).status, 503);
  await f.db.prepare("DROP TABLE organizer_profile").run();
  assert.equal((await f.request("/api/owner/profile", { headers: f.ownerHeaders })).status, 503);
  assert.equal((await f.send("/api/owner/profile", profile, f.ownerHeaders, "PUT")).status, 503);
  assert.equal((await f.request("/api/public")).status, 503);
  assert.equal(
    await getOwnerProfile(new Request(`${f.env.PUBLIC_ORIGIN}/owner/profile?bad=1`), { env: f.env }),
    null
  );
});

test("profile migration leaves populated database bytes and rowids unchanged", async (t) => {
  const f = await apiFixture({ legacyProfile: true });
  t.after(f.close);
  const input = {
    requestKey: "profile-upgrade-booking-0001",
    start: f.now() + 9 * hour,
    name: "Historical",
    email: "old@example.test",
    timeZone: "UTC",
  };
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
  const booking = await service.create(input);
  assert.equal(booking.status, "confirmed");
  const before = await frozenRows(f);
  await f.migrateProfile();
  assert.deepEqual(await frozenRows(f), before);
  assert.deepEqual(await (await f.request("/api/owner/profile", { headers: f.ownerHeaders })).json(), {
    displayName: null,
    bio: "",
  });
  assert.equal((await f.request("/api/events/default")).status, 200);
  assert.deepEqual(await (await f.send("/api/bookings", input)).json(), booking);
  assert.equal(f.calendar.writes.length, 1);
});
