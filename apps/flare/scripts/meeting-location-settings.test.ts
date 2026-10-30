import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, parseEventDetails, parseSettings, SettingsError } from "../src/domain/settings.ts";
import { getSettings } from "../src/server/settings.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

const details = { slug: "intro", title: "Intro call", description: "", durationMinutes: 30 };
const address = 'Room-private-marker\r\n東京 😀 <script>"&</script> Floor 2';
const withLocation = (location: unknown) => ({ ...settings, event: { ...settings.event, location } });

test("booking-rule partial saves canonicalize every existing policy-key presence and admit fresh bookings", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  let command = 0;
  for (const location of [undefined, address])
    for (const value of [false, true])
      for (const reverse of [false, true])
        for (const presence of ["neither", "cancelling", "rescheduling", "both"]) {
          const policies = reverse
            ? { disableRescheduling: value, disableCancelling: value }
            : { disableCancelling: value, disableRescheduling: value };
          const event = {
            ...settings.event,
            ...Object.fromEntries(
              Object.entries(policies).filter(
                ([key]) =>
                  presence === "both" ||
                  (presence === "cancelling" && key === "disableCancelling") ||
                  (presence === "rescheduling" && key === "disableRescheduling")
              )
            ),
            ...(location === undefined ? {} : { location }),
          };
          const label = `${presence}, value=${value}, reverse=${reverse}, location=${location !== undefined}`;
          assert.equal(
            (await f.send("/api/owner", { ...settings, event }, f.ownerHeaders, "PUT")).status,
            200
          );
          const before = await f.db
            .prepare("SELECT version FROM organizer_settings")
            .first<{ version: number }>();
          const rules = {
            intervalMinutes: 30,
            beforeMinutes: 0,
            afterMinutes: 0,
            noticeMinutes: 0,
            ...policies,
          };
          assert.equal(
            (await f.send("/api/owner/booking-rules", rules, f.ownerHeaders, "PATCH")).status,
            200
          );
          const current = await getSettings(f.db);
          const raw = await f.db
            .prepare("SELECT json, version FROM organizer_settings")
            .first<{ json: string; version: number }>();
          assert.deepEqual(current, {
            ...settings,
            event: { ...settings.event, ...rules, ...(location === undefined ? {} : { location }) },
          });
          assert.equal(raw?.version, (before?.version ?? 0) + 1);
          const created = await f.send(
            "/api/bookings",
            {
              requestKey: `policy-location-admission-${++command}`,
              start: f.now() + command * hour,
              name: "Guest",
              email: "guest@example.test",
              timeZone: "UTC",
            },
            { "CF-Connecting-IP": `192.0.2.${command}` }
          );
          assert.equal(created.status, 201, `${label}: ${await created.text()}`);
          assert.equal(raw?.json, JSON.stringify(current), label);
        }
});

test("location parsing preserves legacy bytes, normalizes blanks and enforces normalized UTF-16 limits", () => {
  assert.equal(JSON.stringify(parseSettings(defaultSettings)), JSON.stringify(defaultSettings));
  for (const [input, expected] of [
    [" \nRoom A\t ", "Room A"],
    [address, address],
    ["", undefined],
    [" \n\t", undefined],
  ]) {
    const parsed = parseSettings(withLocation(input));
    assert.equal(Reflect.get(parsed.event, "location"), expected);
    assert.equal(Object.hasOwn(parsed.event, "location"), expected !== undefined);
  }
  for (const location of ["x".repeat(1000), "😀".repeat(500), `${'"\\\n'.repeat(333)}x`])
    assert.equal(Reflect.get(parseSettings(withLocation(`  ${location}  `)).event, "location"), location);
  for (const location of [
    undefined,
    null,
    false,
    42,
    {},
    [],
    "x".repeat(1001),
    `${"😀".repeat(500)}x`,
    `${'"\\\n'.repeat(333)}xx`,
  ]) {
    assert.throws(() => parseSettings(withLocation(location)), SettingsError);
    assert.throws(() => parseEventDetails({ ...details, location }), SettingsError);
  }
  assert.deepEqual(parseEventDetails(details), details);
  assert.deepEqual(parseEventDetails({ ...details, location: " \n" }), { ...details, location: "" });
  assert.throws(() => parseEventDetails({ ...details, location: address, extra: true }), SettingsError);
});

test("owner location writes remain private, canonical and admissible across partial-save orders", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const raw = () =>
    f.db.prepare("SELECT json, version FROM organizer_settings").first<{ json: string; version: number }>();
  const patch = async (path: string, input: unknown) => {
    const before = await raw();
    assert.equal((await f.send(path, input, f.ownerHeaders, "PATCH")).status, 200);
    const after = await raw();
    assert.equal(after?.version, (before?.version ?? 0) + 1);
    assert.equal(after?.json, JSON.stringify(await getSettings(f.db)), "stored settings must admit bookings");
  };
  const rules = {
    intervalMinutes: 30,
    beforeMinutes: 0,
    afterMinutes: 0,
    noticeMinutes: 0,
    disableCancelling: false,
    disableRescheduling: false,
  };
  const weekly = {
    timeZone: "UTC",
    rules: settings.schedule.rules.map((rule) => ({ ...rule, startMinute: 60, endMinute: 1380 })),
  };
  for (const rulesFirst of [false, true]) {
    assert.equal((await f.send("/api/owner", settings, f.ownerHeaders, "PUT")).status, 200);
    if (rulesFirst) await patch("/api/owner/booking-rules", rules);
    await patch("/api/owner", { ...details, location: `  ${address}  ` });
    if (!rulesFirst) await patch("/api/owner/booking-rules", rules);
    await patch("/api/owner", details);
    assert.equal(Reflect.get((await getSettings(f.db)).event, "location"), address);
    await patch("/api/owner", { ...details, location: " \t" });
    assert.equal(Object.hasOwn((await getSettings(f.db)).event, "location"), false);
    await patch("/api/owner", { ...details, location: address });
    const version = (await raw())?.version ?? 0;
    for (const response of await Promise.all([
      f.send("/api/owner/schedule", weekly, f.ownerHeaders, "PATCH"),
      f.send(
        "/api/owner/overrides",
        { overrides: [{ date: "2030-02-01", ranges: [] }] },
        f.ownerHeaders,
        "PATCH"
      ),
      f.send("/api/owner/booking-rules", rules, f.ownerHeaders, "PATCH"),
      f.send("/api/owner", { ...details, location: address }, f.ownerHeaders, "PATCH"),
    ]))
      assert.equal(response.status, 200);
    assert.equal((await raw())?.version, version + 4);
    assert.equal((await raw())?.json, JSON.stringify(await getSettings(f.db)));
    const current = await getSettings(f.db);
    assert.equal(Reflect.get(current.event, "location"), address);
    assert.deepEqual(current.schedule.rules, weekly.rules);
    assert.deepEqual(current.schedule.overrides, [{ date: "2030-02-01", ranges: [] }]);
    assert.equal(current.event.disableCancelling, false);
    const created = await f.send("/api/bookings", {
      requestKey: `location-admission-${rulesFirst}`,
      start: f.now() + (rulesFirst ? 11 : 9) * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    });
    assert.equal(created.status, 201);
  }
  for (const event of f.calendar.events.values())
    assert.equal(JSON.stringify(event).includes("Room-private-marker"), false);
  for (const location of ["A\ud800B", "A\udfffB", "A\u0000B", address]) {
    await patch("/api/owner", { ...details, location });
    await patch("/api/owner/booking-rules", rules);
    assert.ok(
      (await getSettings(f.db)).event.location === location,
      "partial saves preserve string code units"
    );
  }
  const owner = await (await f.request("/api/owner", { headers: f.ownerHeaders })).json();
  assert.equal(owner.settings.event.location, address);
  for (const path of [
    "/api/public",
    "/api/owner",
    "/api/owner/bookings/missing",
    "/api/slots?from=2030-01-02T00:00:00Z&to=2030-01-03T00:00:00Z&timeZone=UTC",
    "/api/slots?timeZone=invalid",
  ]) {
    const response = await f.request(path);
    assert.equal((await response.text()).includes("Room-private-marker"), false);
  }
  const before = await raw();
  const writes = f.calendar.writes.length;
  for (const location of [null, 7, "x".repeat(1001)])
    for (const method of ["PUT", "PATCH"])
      assert.equal(
        (
          await f.send(
            "/api/owner",
            method === "PUT" ? withLocation(location) : { ...details, location },
            f.ownerHeaders,
            method
          )
        ).status,
        400
      );
  for (const headers of [
    {},
    { Cookie: "flare_session=invalid" },
    { ...f.ownerHeaders, Origin: "https://foreign.test" },
  ])
    assert.ok(
      [401, 403].includes(
        (await f.send("/api/owner", { ...details, location: "Changed" }, headers, "PATCH")).status
      )
    );
  assert.deepEqual(await raw(), before);
  assert.equal(f.calendar.writes.length, writes);
  assert.equal((await f.send("/api/owner", withLocation(` ${address} `), f.ownerHeaders, "PUT")).status, 200);
  assert.equal(Reflect.get((await getSettings(f.db)).event, "location"), address);
  for (const input of [withLocation(" \n"), settings]) {
    assert.equal((await f.send("/api/owner", input, f.ownerHeaders, "PUT")).status, 200);
    assert.equal(Object.hasOwn((await getSettings(f.db)).event, "location"), false);
  }
  const unchanged = await raw();
  await f.db.prepare("UPDATE owner_session SET expires_at = 0").run();
  assert.equal((await f.send("/api/owner", withLocation(address), f.ownerHeaders, "PUT")).status, 401);
  await f.db.prepare("DELETE FROM owner_session").run();
  assert.equal(
    (await f.send("/api/owner", { ...details, location: address }, f.ownerHeaders, "PATCH")).status,
    401
  );
  assert.deepEqual(await raw(), unchanged);
  assert.equal(f.calendar.writes.length, writes);
});
