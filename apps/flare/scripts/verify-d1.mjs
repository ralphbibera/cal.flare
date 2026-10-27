import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPlatformProxy } from "wrangler";

const experiment = new URL("../../../experiments/d1-reservations/", import.meta.url);
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
const statements = (await readFile(new URL("submit.sql", experiment), "utf8"))
  .split(";")
  .map((sql) => sql.trim())
  .filter(Boolean);
const temporary = await mkdtemp(join(tmpdir(), "calflare-d1-"));
let platform = null;
let db = null;

function command(organizer, key, start = 100, end = 200, eventType = "intro", capacity = null) {
  const identity = createHash("sha256")
    .update(JSON.stringify([organizer, key]))
    .digest("hex");
  return {
    organizer_id: organizer,
    request_key: key,
    booking_id: identity,
    event_type_id: eventType,
    start_ms: start,
    end_ms: end,
    request_payload: JSON.stringify({ capacity, end, eventType, kind: "create", start }),
    google_event_id: identity,
    seat_capacity: capacity,
    seat_attendee_id: null,
  };
}

function seatCommand(organizer, key, booking, attendee) {
  return {
    ...command(organizer, key),
    booking_id: booking,
    seat_attendee_id: attendee,
    request_payload: JSON.stringify({ kind: "seat", booking, attendee }),
  };
}

function prepare(sql, parameters) {
  const values = [];
  const query = sql.replace(/:([a-z_]+)/g, (_match, key) => {
    assert.ok(Object.hasOwn(parameters, key), `Unknown parameter ${key}`);
    values.push(parameters[key]);
    return "?";
  });
  return db.prepare(query).bind(...values);
}

async function submit(parameters, additional = []) {
  const results = await db.batch([...statements.map((sql) => prepare(sql, parameters)), ...additional]);
  const result = results[statements.length - 1].results[0];
  assert.ok(result.outcome === "accepted" || result.outcome === "conflict");
  return result;
}

async function counts(organizer) {
  const results = await db.batch(
    ["booking_command", "reservation", "calendar_operation"].map((table) =>
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE organizer_id = ?`).bind(organizer)
    )
  );
  return results.map((result) => result.results[0].n);
}

function pass(message) {
  process.stdout.write(`PASS ${message}\n`);
}

try {
  await promisify(execFile)(process.execPath, [
    wrangler,
    "d1",
    "execute",
    "calflare",
    "--local",
    "--persist-to",
    temporary,
    "--file",
    fileURLToPath(new URL("schema.sql", experiment)),
    "--config",
    configPath,
  ]);
  platform = await getPlatformProxy({
    configPath,
    persist: { path: join(temporary, "v3") },
    remoteBindings: false,
  });
  db = platform.env.DB;
  for (const [index, [start, end]] of [
    [100, 200],
    [50, 150],
    [150, 250],
    [120, 180],
    [50, 250],
  ].entries()) {
    const owner = `matrix-${index}`;
    assert.equal((await submit(command(owner, "first"))).outcome, "accepted");
    assert.equal((await submit(command(owner, "overlap", start, end, "another-type"))).outcome, "conflict");
    assert.equal((await submit(command(owner, "before", 0, 100))).outcome, "accepted");
    assert.equal((await submit(command(owner, "after", 200, 300))).outcome, "accepted");
    assert.deepEqual(await counts(owner), [4, 3, 3]);
  }
  assert.equal((await submit(command("another-owner", "first"))).outcome, "accepted");
  pass("D1 accepts adjacency and other organizers, rejects arbitrary same-organizer overlaps");

  const original = command("replay", "same-key");
  const accepted = await submit(original);
  assert.deepEqual(await submit(original), accepted);
  const snapshot = await db.prepare("SELECT * FROM booking_command WHERE organizer_id = 'replay'").all();
  for (const field of [
    "booking_id",
    "event_type_id",
    "start_ms",
    "end_ms",
    "request_payload",
    "google_event_id",
    "seat_capacity",
  ]) {
    const changed = { ...original };
    if (changed[field] === null) {
      changed[field] = 2;
    } else if (typeof changed[field] === "number") {
      changed[field] += 1;
    } else {
      changed[field] = `${changed[field]}changed`;
    }
    await assert.rejects(submit(changed), /idempotency_mismatch/);
    const current = await db.prepare("SELECT * FROM booking_command WHERE organizer_id = 'replay'").all();
    assert.deepEqual(current.results, snapshot.results);
  }
  const retries = await Promise.all([submit(original), submit(original)]);
  assert.deepEqual(retries, [accepted, accepted]);
  assert.deepEqual(await counts("replay"), [1, 1, 1]);
  pass("D1 replays share one intent and reject changes to every immutable field");

  const conflict = command("replay", "blocked");
  const rejected = await submit(conflict);
  assert.equal(rejected.outcome, "conflict");
  await db.prepare("DELETE FROM reservation WHERE organizer_id = 'replay'").run();
  assert.deepEqual(await submit(conflict), rejected);
  assert.deepEqual(await counts("replay"), [2, 0, 1]);
  pass("D1 preserves a conflicting command outcome after its blocker is removed");

  await db.prepare("CREATE TABLE injected_failure (value INTEGER CHECK (value > 0))").run();
  await assert.rejects(
    submit(command("rollback", "later-statement"), [
      db.prepare("INSERT INTO injected_failure (value) VALUES (-1)"),
    ]),
    /CHECK constraint failed/
  );
  assert.deepEqual(await counts("rollback"), [0, 0, 0]);
  await db
    .prepare(`CREATE TRIGGER injected_intent_failure BEFORE INSERT ON calendar_operation
    WHEN NEW.organizer_id = 'intent-failure'
    BEGIN SELECT RAISE(ABORT, 'injected_after_reservation'); END`)
    .run();
  await assert.rejects(submit(command("intent-failure", "first")), /injected_after_reservation/);
  assert.deepEqual(await counts("intent-failure"), [0, 0, 0]);
  pass("D1 rolls back reservation, command, and intent on trigger or later batch failure");

  const held = command("held", "first");
  await submit(held);
  await db
    .prepare("INSERT INTO reservation VALUES (?, ?, 'candidate', 300, 400)")
    .bind("held", held.booking_id)
    .run();
  assert.equal((await submit(command("held", "old", 120, 180))).outcome, "conflict");
  assert.equal((await submit(command("held", "new", 320, 380))).outcome, "conflict");
  assert.equal((await submit(command("held", "gap", 200, 300))).outcome, "accepted");
  const gap = command("held", "gap", 200, 300);
  await assert.rejects(
    db
      .prepare("INSERT INTO reservation VALUES (?, ?, 'candidate', 150, 250)")
      .bind("held", gap.booking_id)
      .run(),
    /reservation_overlap/
  );
  await assert.rejects(
    db.prepare("UPDATE reservation SET start_ms = 150 WHERE booking_id = ?").bind(gap.booking_id).run(),
    /replace_reservation_atomically/
  );
  pass("D1 guards direct writes and keeps old/candidate occupancy separate");

  for (let round = 0; round < 50; round++) {
    const owner = `race-${round}`;
    const results = await Promise.all([
      submit(command(owner, "left", 100, 200)),
      submit(command(owner, "right", 150, 250, "another-type")),
    ]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["accepted", "conflict"]);
    assert.deepEqual(await counts(owner), [2, 1, 1]);
  }
  const overlaps = await db
    .prepare(`SELECT count(*) AS n FROM reservation a JOIN reservation b
    ON a.organizer_id = b.organizer_id AND a.booking_id < b.booking_id
    WHERE a.start_ms < b.end_ms AND b.start_ms < a.end_ms`)
    .first("n");
  assert.equal(overlaps, 0);
  pass("50 concurrent D1 batch pairs each persist one winner, one conflict, and one intent");

  for (let round = 0; round < 50; round++) {
    const owner = `seats-${round}`;
    const occurrence = command(owner, "occurrence", 100, 200, "intro", 2);
    assert.equal((await submit(occurrence)).outcome, "accepted");
    const first = seatCommand(owner, "first", occurrence.booking_id, "attendee-1");
    assert.equal((await submit(first)).outcome, "accepted");
    const inputs = [
      seatCommand(owner, "left", occurrence.booking_id, "attendee-2"),
      seatCommand(owner, "right", occurrence.booking_id, "attendee-3"),
    ];
    const results = await Promise.all(inputs.map((input) => submit(input)));
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["accepted", "conflict"]);
    assert.deepEqual(await Promise.all(inputs.map((input) => submit(input))), results);
    const winner = inputs[results.findIndex((result) => result.outcome === "accepted")];
    const accepted = results.find((result) => result.outcome === "accepted");
    assert.deepEqual(await Promise.all([submit(winner), submit(winner)]), [accepted, accepted]);
    for (const [table, expected] of [
      ["seat_claim", 2],
      ["seat_request", 3],
    ]) {
      const n = await db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE organizer_id = ?`)
        .bind(owner)
        .first("n");
      assert.equal(n, expected);
    }
    assert.deepEqual(await counts(owner), [1, 1, 1]);
    const snapshot = await db
      .prepare("SELECT * FROM seat_request WHERE organizer_id = ? ORDER BY request_key")
      .bind(owner)
      .all();
    for (const field of ["booking_id", "seat_attendee_id", "request_payload"]) {
      await assert.rejects(submit({ ...first, [field]: `${first[field]}changed` }), /idempotency_mismatch/);
      const current = await db
        .prepare("SELECT * FROM seat_request WHERE organizer_id = ? ORDER BY request_key")
        .bind(owner)
        .all();
      assert.deepEqual(current.results, snapshot.results);
    }
    await db
      .prepare("DELETE FROM seat_claim WHERE organizer_id = ? AND request_key = ?")
      .bind(owner, winner.request_key)
      .run();
    const loser = inputs[results.findIndex((result) => result.outcome === "conflict")];
    assert.equal((await submit(loser)).outcome, "conflict");
  }
  const excess = await db
    .prepare(`SELECT count(*) AS n FROM booking_command b WHERE b.seat_capacity IS NOT NULL
    AND (SELECT count(*) FROM seat_claim s WHERE s.organizer_id = b.organizer_id
    AND s.booking_id = b.booking_id) > b.seat_capacity`)
    .first("n");
  assert.equal(excess, 0);
  pass(
    "50 D1 final-seat races preserve capacity, shared occupancy, one create intent, replay, and durable rejection"
  );

  const occurrence = command("seat-failure", "occurrence", 100, 200, "intro", 1);
  await submit(occurrence);
  const first = seatCommand("seat-failure", "first", occurrence.booking_id, "attendee-1");
  await db
    .prepare(`CREATE TRIGGER injected_seat_failure AFTER INSERT ON seat_claim
    WHEN NEW.organizer_id = 'seat-failure' BEGIN SELECT RAISE(ABORT, 'injected_after_seat'); END`)
    .run();
  await assert.rejects(submit(first), /injected_after_seat/);
  for (const table of ["seat_request", "seat_claim"]) {
    assert.equal(
      await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE organizer_id = 'seat-failure'`).first("n"),
      0
    );
  }
  assert.deepEqual(await counts("seat-failure"), [1, 1, 1]);
  await db.prepare("DROP TRIGGER injected_seat_failure").run();
  await submit(first);
  await assert.rejects(submit(command("seat-failure", "first")), /idempotency_mismatch/);
  await assert.rejects(
    submit(seatCommand("seat-failure", "occurrence", occurrence.booking_id, "other")),
    /idempotency_mismatch/
  );
  await assert.rejects(
    submit(seatCommand("wrong-owner", "first", occurrence.booking_id, "attendee")),
    /FOREIGN KEY/
  );
  const batchOccurrence = command("seat-batch", "occurrence", 100, 200, "intro", 1);
  await submit(batchOccurrence);
  await assert.rejects(
    submit(seatCommand("seat-batch", "first", batchOccurrence.booking_id, "attendee"), [
      db.prepare("INSERT INTO injected_failure (value) VALUES (-1)"),
    ]),
    /CHECK constraint failed/
  );
  for (const table of ["seat_request", "seat_claim"]) {
    assert.equal(
      await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE organizer_id = 'seat-batch'`).first("n"),
      0
    );
  }
  assert.equal(
    (await submit(seatCommand("seat-failure", "full", occurrence.booking_id, "other"))).outcome,
    "conflict"
  );
  await assert.rejects(
    db
      .prepare("INSERT INTO seat_claim VALUES ('seat-failure', ?, 'other', 'full')")
      .bind(occurrence.booking_id)
      .run(),
    /seat_capacity/
  );
  await assert.rejects(
    db.prepare("UPDATE seat_claim SET attendee_id = 'other'").run(),
    /replace_seat_atomically/
  );
  pass(
    "D1 seat admission rolls back on failure, rejects cross-kind replay and cross-owner references, and guards direct writes"
  );
  process.stdout.write(
    "Local workerd/D1 verified. Deployed D1, HTTP booking, seat lifecycle, provider delivery, and operating cost remain unverified.\n"
  );
} finally {
  try {
    await platform?.dispose();
  } finally {
    await rm(temporary, { recursive: true });
  }
}
