import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPlatformProxy } from "wrangler";

type Input = {
  id: string | null;
  eventId?: string;
  eventScheduleId?: string | null;
  resolvedScheduleId?: string | null;
  requestKey?: string;
  booking: string;
  start: number;
  end: number;
  action?: "create" | "reschedule" | "cancel";
  version?: number;
  payload?: string;
  desired?: string;
  settings?: string;
  tokenHash?: string;
  precondition?: "accepted" | "conflict" | "invalid_slot";
};

test("D1 booking commands atomically retain intent and occupancy through lifecycle transitions", async () => {
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const temporary = await mkdtemp(join(tmpdir(), "flare-booking-storage-"));
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  try {
    for (const name of [
      "0002_settings.sql",
      "0003_bookings.sql",
      "0005_events.sql",
      "0006_event_lifecycle.sql",
      "0007_availability_schedules.sql",
      "0008_public_profile.sql",
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
          fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
          "--config",
          configPath,
        ],
        { env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }
      );
    }
    const connect = () =>
      getPlatformProxy<{ DB: D1Database }>({
        configPath,
        persist: { path: join(temporary, "v3") },
        remoteBindings: false,
      });
    platform = await connect();
    let db = platform.env.DB;
    await db.prepare("UPDATE organizer_settings SET json='{}'").run();
    await db.prepare("UPDATE event_type SET json='{}'").run();
    await db.prepare("UPDATE availability_schedule SET json='{}'").run();
    await db.prepare("INSERT INTO event_type(id,json,version) VALUES ('second','{}',1)").run();
    const statement = (input: Input) =>
      db
        .prepare(`
      INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
        desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due,event_id,event_schedule_id,resolved_schedule_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO UPDATE SET
        id=excluded.id, request_key=excluded.request_key, booking_id=excluded.booking_id,
        action=excluded.action, payload=excluded.payload, expected_version=excluded.expected_version,
        desired_json=excluded.desired_json, settings_json=excluded.settings_json,
        token_hash=excluded.token_hash, occupied_start=excluded.occupied_start,
        occupied_end=excluded.occupied_end, precondition=excluded.precondition,event_id=excluded.event_id,
        event_schedule_id=excluded.event_schedule_id,resolved_schedule_id=excluded.resolved_schedule_id
    `)
        .bind(
          input.id,
          input.requestKey ?? input.id ?? "null-key",
          input.booking,
          input.action ?? "create",
          input.payload ?? "canonical-input",
          input.version ?? 0,
          input.desired ?? JSON.stringify({ label: input.id }),
          input.settings ?? '{"event":{},"schedule":{}}',
          input.tokenHash ?? "management-hash",
          input.start,
          input.end,
          input.precondition ?? "accepted",
          0,
          input.eventId ?? "default",
          input.eventScheduleId ?? null,
          input.resolvedScheduleId === undefined ? "legacy" : input.resolvedScheduleId
        );
    const submit = (input: Input) => db.batch([statement(input)]);
    const outcome = (id: string) =>
      db.prepare("SELECT outcome FROM booking_command WHERE id=?").bind(id).first("outcome");
    const ranges = (id: string) =>
      db
        .prepare("SELECT role,start,end FROM booking_reservation WHERE booking_id=? ORDER BY start")
        .bind(id)
        .all();
    const finish = (id: string) =>
      db
        .prepare("UPDATE booking_command SET execution='done',result_etag='\"v1\"',terminal=1 WHERE id=?")
        .bind(id)
        .run();
    const snapshot = async () =>
      Promise.all([
        db.prepare("SELECT * FROM booking ORDER BY id").all(),
        db.prepare("SELECT * FROM booking_command ORDER BY id").all(),
        db.prepare("SELECT * FROM booking_reservation ORDER BY booking_id,role").all(),
      ]).then((results) => results.map((result) => result.results));
    await assert.rejects(
      db
        .prepare(
          "INSERT INTO booking(id,version,state,token_hash,initial_json) VALUES(NULL,1,'unconfirmed','hash','{}')"
        )
        .run(),
      /NOT NULL/
    );
    await assert.rejects(submit({ id: null, booking: "null", start: 0, end: 10 }), /NOT NULL/);
    const first: Input = { id: "create", booking: "first", start: 0, end: 10 };
    await submit(first);
    assert.equal(await outcome("create"), "accepted");
    assert.equal(
      await db.prepare("SELECT execution FROM booking_command WHERE id='create'").first("execution"),
      "queued"
    );
    assert.equal(
      await db.prepare("SELECT pending_id FROM booking WHERE id='first'").first("pending_id"),
      "create"
    );
    assert.deepEqual((await ranges("first")).results, [{ role: "candidate", start: 0, end: 10 }]);
    const accepted = await snapshot();
    await assert.rejects(
      submit({
        id: "wrong-event",
        booking: "first",
        start: 0,
        end: 10,
        action: "cancel",
        version: 1,
        eventId: "second",
      }),
      /event_mismatch/
    );
    await assert.rejects(
      db.prepare("UPDATE booking SET event_id='second' WHERE id='first'").run(),
      /immutable_event/
    );
    await submit(first);
    assert.deepEqual(await snapshot(), accepted);
    await assert.rejects(submit({ ...first, payload: "changed" }), /idempotency_mismatch/);
    const mismatches: Partial<Input>[] = [
      { booking: "different-booking" },
      { eventId: "second" },
      { eventScheduleId: "legacy" },
      { resolvedScheduleId: null },
      { start: 1 },
      { end: 11 },
      { action: "cancel" },
      { version: 1 },
      { id: "different-command", requestKey: "create", desired: '{"label":"create"}' },
      { desired: '{"label":"changed"}' },
      { settings: '{"changed":true}' },
      { tokenHash: "different-hash" },
      { precondition: "conflict" },
    ];
    for (const changed of mismatches) {
      await assert.rejects(submit({ ...first, ...changed }), /idempotency_mismatch/);
      assert.deepEqual(await snapshot(), accepted);
    }
    for (const [field, value] of [
      ["id", "different-command"],
      ["request_key", "different-key"],
      ["booking_id", "other-booking"],
      ["event_id", "second"],
      ["event_schedule_id", "legacy"],
      ["resolved_schedule_id", null],
      ["action", "cancel"],
      ["expected_version", 1],
      ["desired_json", '{"changed":true}'],
      ["settings_json", '{"changed":true}'],
      ["token_hash", "other-hash"],
      ["occupied_start", 1],
      ["occupied_end", 11],
      ["precondition", "conflict"],
      ["outcome", "conflict"],
    ] as const) {
      await assert.rejects(
        db.prepare(`UPDATE booking_command SET ${field}=? WHERE id='create'`).bind(value).run(),
        /idempotency_mismatch/
      );
    }
    assert.deepEqual(await snapshot(), accepted);
    await assert.rejects(
      db.prepare("UPDATE booking_command SET terminal=1 WHERE id='create'").run(),
      /invalid_finalization/
    );
    const beforeRollback = await snapshot();
    await assert.rejects(
      db.batch([
        statement({ id: "rollback", booking: "rolled-back", start: 20, end: 30 }),
        db.prepare("UPDATE organizer_settings SET version=0 WHERE id='owner'"),
      ])
    );
    assert.deepEqual(await snapshot(), beforeRollback);
    await submit({ id: "conflict", booking: "blocked", start: 5, end: 15 });
    assert.equal(await outcome("conflict"), "conflict");
    assert.equal(await db.prepare("SELECT id FROM booking WHERE id='blocked'").first(), null);
    await finish("create");
    await finish("create");
    await assert.rejects(
      db.prepare("UPDATE booking_command SET result_etag='\"changed\"' WHERE id='create'").run(),
      /idempotency_mismatch/
    );
    assert.deepEqual((await ranges("first")).results, [{ role: "current", start: 0, end: 10 }]);
    await submit({ id: "move", booking: "first", start: 30, end: 40, action: "reschedule", version: 1 });
    await db.prepare("UPDATE booking_command SET base_etag='\"frozen\"' WHERE id='move'").run();
    await assert.rejects(
      db.prepare("UPDATE booking_command SET base_etag='\"changed\"' WHERE id='move'").run(),
      /idempotency_mismatch/
    );
    assert.deepEqual((await ranges("first")).results, [
      { role: "current", start: 0, end: 10 },
      { role: "candidate", start: 30, end: 40 },
    ]);
    await submit({ id: "gap", booking: "gap", start: 15, end: 20 });
    assert.equal(await outcome("gap"), "accepted");
    await submit({ id: "adjacent", booking: "adjacent", start: 40, end: 50 });
    assert.equal(await outcome("adjacent"), "accepted", "Touching endpoints must not conflict");
    await submit({ id: "busy", booking: "first", start: 50, end: 60, action: "reschedule", version: 2 });
    assert.equal(await outcome("busy"), "busy");
    await finish("move");
    assert.deepEqual((await ranges("first")).results, [{ role: "current", start: 30, end: 40 }]);
    await submit({ id: "stale", booking: "first", start: 50, end: 60, action: "reschedule", version: 1 });
    assert.equal(await outcome("stale"), "stale");
    await submit({ id: "cancel", booking: "first", start: 30, end: 40, action: "cancel", version: 2 });
    assert.deepEqual((await ranges("first")).results, [{ role: "current", start: 30, end: 40 }]);
    await finish("cancel");
    assert.deepEqual((await ranges("first")).results, []);
    assert.equal(await db.prepare("SELECT state FROM booking WHERE id='first'").first("state"), "cancelled");
    await submit({ id: "conflict", booking: "blocked", start: 5, end: 15 });
    assert.equal(
      await outcome("conflict"),
      "conflict",
      "A recorded rejection must not change when its blocker disappears"
    );
    for (let index = 0; index < 50; index++) {
      const start = 100 + index * 20;
      const inputs = ["a", "b"].map((side) => ({
        id: `race-${index}-${side}`,
        booking: `race-${index}-${side}`,
        eventId: side === "a" ? "default" : "second",
        start,
        end: start + 10,
      }));
      await Promise.all(inputs.map(submit));
      assert.deepEqual((await Promise.all(inputs.map((input) => outcome(input.id)))).sort(), [
        "accepted",
        "conflict",
      ]);
    }
    const allRanges = (
      await db
        .prepare("SELECT booking_id,start,end FROM booking_reservation")
        .all<{ booking_id: string; start: number; end: number }>()
    ).results;
    for (const [index, left] of allRanges.entries()) {
      for (const right of allRanges.slice(index + 1)) {
        assert.ok(left.booking_id === right.booking_id || left.end <= right.start || right.end <= left.start);
      }
    }
    await submit({
      id: "missing-provenance",
      booking: "missing-provenance",
      start: 2000,
      end: 2010,
      resolvedScheduleId: null,
    });
    assert.equal(await outcome("missing-provenance"), "settings_changed");
    assert.equal(await db.prepare("SELECT id FROM booking WHERE id='missing-provenance'").first(), null);
    const persisted = await snapshot();
    await platform.dispose();
    platform = undefined;
    platform = await connect();
    db = platform.env.DB;
    assert.deepEqual(await snapshot(), persisted);
  } finally {
    try {
      await platform?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
