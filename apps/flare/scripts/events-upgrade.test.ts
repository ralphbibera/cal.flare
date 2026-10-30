import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { defaultSettings } from "../src/domain/settings.ts";
import type { BookingSnapshot } from "../src/server/booking-model.ts";
import { BookingService } from "../src/server/bookings.ts";
import { hash } from "../src/server/secrets.ts";
import { getSettings, saveSettings } from "../src/server/settings.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

test("populated D1 upgrade retains legacy command bytes, rowids, capabilities, outcomes and recovery", async (t) => {
  const f = await apiFixture({ legacyEvents: true });
  t.after(f.close);
  const rawSettings = JSON.stringify({
    ...settings,
    event: { ...settings.event, location: "Old\ud800\u0000東京", bookingWindowDays: 30 },
  });
  await f.db.prepare("UPDATE organizer_settings SET json=?").bind(rawSettings).run();
  const inputs = [];
  for (const [index, mode] of ["completed", "rejected", "queued", "sent"].entries()) {
    const data = {
      requestKey: `legacy-event-${mode}-0001`,
      start: f.now() + (mode === "rejected" ? 9 : 9 + index * 2) * hour,
      name: "Historical",
      email: "old@example.test",
      timeZone: "UTC",
    };
    const id = createHash("sha256").update(`calflare:booking:v1:${data.requestKey}`).digest("hex");
    const commandId = createHash("sha256").update(`calflare:command:v1:${data.requestKey}`).digest("hex");
    const token = createHmac("sha256", Buffer.from(f.env.TOKEN_ENCRYPTION_KEY, "base64"))
      .update(`calflare:booking-management:v1:${id}`)
      .digest("base64url");
    const desired: BookingSnapshot = {
      id,
      start: data.start,
      end: data.start + hour / 2,
      title: "Intro call",
      description: "Meet the organizer",
      timeZone: "UTC",
      attendee: { name: data.name, email: data.email },
      privateMetadata: { application: "calflare", booking: id, operation: commandId },
      location: "Old\ud800\u0000東京",
    };
    await f.db
      .prepare(`INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
      desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due)
      VALUES(?,?,?,'create',?,0,?,?,?,?,?,'accepted',0)`)
      .bind(
        commandId,
        data.requestKey,
        id,
        JSON.stringify({ action: "create", ...data }),
        JSON.stringify(desired),
        rawSettings,
        await hash(token),
        desired.start,
        desired.end
      )
      .run();
    if (mode === "completed" || mode === "sent") {
      const remote = await f.calendar.insert(desired);
      if (mode === "completed")
        await f.db
          .prepare("UPDATE booking_command SET execution='done',result_etag=?,terminal=1 WHERE id=?")
          .bind(remote.etag, commandId)
          .run();
      else
        await f.db
          .prepare("UPDATE booking_command SET execution='sent',dispatch_nonce='old-dispatch' WHERE id=?")
          .bind(commandId)
          .run();
    }
    inputs.push({ data, id, token, mode });
  }
  const before = await Promise.all([
    f.db.prepare("SELECT rowid AS cursor,* FROM booking ORDER BY rowid").all(),
    f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all(),
    f.db.prepare("SELECT * FROM booking_reservation ORDER BY booking_id,role").all(),
  ]);
  assert.deepEqual(
    before[1].results.map((c) => c.outcome),
    ["accepted", "conflict", "accepted", "accepted"]
  );
  await f.migrateEvents();
  const after = await Promise.all([
    f.db.prepare("SELECT rowid AS cursor,* FROM booking ORDER BY rowid").all(),
    f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all(),
    f.db.prepare("SELECT * FROM booking_reservation ORDER BY booking_id,role").all(),
  ]);
  for (const index of [0, 1]) {
    assert.deepEqual(
      after[index].results.map(({ event_id, ...row }) => {
        assert.equal(event_id, "default");
        return row;
      }),
      before[index].results
    );
  }
  assert.deepEqual(after[2].results, before[2].results);
  assert.deepEqual(await getSettings(f.db), JSON.parse(rawSettings));
  assert.equal(
    await f.db.prepare("SELECT json FROM event_type WHERE id='default'").first("json"),
    JSON.stringify(JSON.parse(rawSettings).event)
  );
  assert.equal(
    await f.db.prepare("SELECT json -> '$.event' AS event FROM organizer_settings").first("event"),
    null
  );
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
  await saveSettings(f.db, {
    ...settings,
    event: { ...settings.event, title: "Later", noticeMinutes: 43200 },
    schedule: { ...settings.schedule, rules: [] },
    conflictCalendarIds: [],
  });
  for (const item of inputs) {
    if (item.mode === "rejected") {
      await assert.rejects(service.create(item.data), /conflict/);
      continue;
    }
    const replay = await service.create(item.data);
    assert.equal(replay.id, item.id);
    assert.equal(replay.manageToken, item.token);
    assert.equal(replay.title, "Intro call");
    assert.equal(replay.location, "Old\ud800\u0000東京");
    assert.equal(replay.status, "confirmed");
    assert.equal(f.calendar.writes.filter((w) => w.id === item.id).length, 1);
  }
  const rejected = await f.db.prepare("SELECT * FROM booking_command WHERE outcome='conflict'").first();
  assert.deepEqual(rejected, { ...before[1].results[1], event_id: "default" });
  await service.recover();
  assert.equal(f.calendar.writes.length, 3);
  for (const old of before[1].results) {
    const current = await f.db
      .prepare("SELECT payload,settings_json,desired_json,token_hash,outcome FROM booking_command WHERE id=?")
      .bind(old.id)
      .first();
    assert.deepEqual(current, {
      payload: old.payload,
      settings_json: old.settings_json,
      desired_json: old.desired_json,
      token_hash: old.token_hash,
      outcome: old.outcome,
    });
  }
});

test("D1 migration seeds defaults only for absent settings and fails without replacing corrupt state", async (t) => {
  const f = await apiFixture({ legacyEvents: true });
  t.after(f.close);
  for (const json of ["broken JSON", "{}", '{"schedule":{}}', '{"event":null,"schedule":{}}']) {
    await f.db.prepare("UPDATE organizer_settings SET json=?").bind(json).run();
    const before = await f.db.prepare("SELECT * FROM organizer_settings").first();
    await assert.rejects(f.migrateEvents(), /malformed JSON|NOT NULL|CHECK constraint/);
    assert.deepEqual(await f.db.prepare("SELECT * FROM organizer_settings").first(), before);
    assert.equal(
      await f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='event_type'").first("n"),
      0
    );
  }
  await f.db.prepare("DELETE FROM organizer_settings").run();
  await f.migrateEvents();
  assert.deepEqual(await getSettings(f.db), defaultSettings);
  assert.equal(await f.db.prepare("SELECT count(*) AS n FROM event_type").first("n"), 1);
});
