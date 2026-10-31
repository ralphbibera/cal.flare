import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here: string = import.meta.dir;
const root: string = fileURLToPath(new URL("../../../../", import.meta.url));
const migrations: string = join(root, "apps/flare/migrations");
const server: string = join(root, "apps/flare/src/server");
const jarSha = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const covered: string[] = [
  "apps/flare/migrations",
  "apps/flare/src/server/bookings.ts",
  "apps/flare/src/server/booking-delivery.ts",
  "apps/flare/src/server/booking-availability.ts",
  "apps/flare/src/server/booking-model.ts",
  "apps/flare/src/server/settings.ts",
  "apps/flare/src/domain/settings.ts",
  "apps/flare/src/domain/scheduling.ts",
];

function sqlFrom(file: string, prefix: string): string {
  const source = readFileSync(join(server, file), "utf8");
  for (const match of source.matchAll(/\.prepare\(`([^`]+)`\)/g)) {
    const sql = match[1];
    if (sql?.startsWith(prefix)) return sql;
  }
  throw new Error(`Cannot extract ${prefix} from ${file}; review the source mapping in SKILL.md.`);
}

function command(cmd: string[]): string {
  const result = Bun.spawnSync({ cmd, cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd[0]} failed (${result.exitCode}): ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function sqlWitness(): void {
  const admit = sqlFrom("bookings.ts", "INSERT INTO booking_command");
  const finish = sqlFrom("booking-delivery.ts", "UPDATE booking_command SET terminal=1");
  const temporary = mkdtempSync(join(tmpdir(), "flare-formal-sql-"));
  const path = join(temporary, "booking.sqlite");
  let db = new Database(path);
  try {
    for (const name of [
      "0002_settings.sql",
      "0003_bookings.sql",
      "0005_events.sql",
      "0006_event_lifecycle.sql",
      "0007_availability_schedules.sql",
      "0008_public_profile.sql",
    ]) {
      db.exec(readFileSync(join(migrations, name), "utf8"));
    }
    for (const table of ["organizer_settings", "event_type", "availability_schedule"]) {
      db.run(`UPDATE ${table} SET json='{}'`);
    }
    db.run("INSERT INTO event_type(id,json,version) VALUES('second','{}',1)");

    function outcome(key: string): unknown {
      return db
        .query<{ outcome: unknown }, [string]>("SELECT outcome FROM booking_command WHERE id=?")
        .get(key)?.outcome;
    }

    function submit({
      key,
      booking,
      start,
      end,
      action = "create",
      version = 0,
      event = "default",
    }: {
      key: string;
      booking: string;
      start: number;
      end: number;
      action?: "create" | "reschedule" | "cancel";
      version?: number;
      event?: string;
    }): unknown {
      db.transaction(() => {
        db.query(admit).run(
          key,
          key,
          booking,
          action,
          key,
          version,
          "{}",
          '{"event":{},"schedule":{}}',
          "hash",
          start,
          end,
          "accepted",
          0,
          event,
          null,
          "legacy"
        );
      })();
      return outcome(key);
    }

    function safe(): void {
      const overlaps = db
        .query(`SELECT a.booking_id AS first_booking,a.role AS first_role,
        b.booking_id AS second_booking,b.role AS second_role
        FROM booking_reservation a JOIN booking_reservation b
        ON a.booking_id < b.booking_id
        WHERE a.start < b.end AND b.start < a.end`)
        .all();
      assert.equal(overlaps.length, 0, `NoOverlap violated in real SQL: ${JSON.stringify(overlaps)}`);
    }

    function complete(key: string): void {
      db.transaction(() => {
        db.query("UPDATE booking_command SET nonce='worker',execution='sent' WHERE id=?").run(key);
        db.query(finish).run('"etag"', key, "worker");
      })();
      safe();
    }

    assert.equal(submit({ key: "create", booking: "first", start: 0, end: 10 }), "accepted");
    safe();
    // Check overlap before the outcome so broken guards expose actual conflicting holds.
    submit({ key: "blocked", booking: "second", start: 5, end: 15, event: "second" });
    safe();
    assert.equal(outcome("blocked"), "conflict");
    complete("create");
    assert.equal(
      submit({ key: "move", booking: "first", start: 10, end: 20, action: "reschedule", version: 1 }),
      "accepted"
    );
    for (const execution of ["queued", "sent"]) {
      db.transaction(() => {
        db.query("UPDATE booking_command SET execution=? WHERE id='move'").run(execution);
      })();
      db.close();
      db = new Database(path);
      for (const start of [0, 5, 10]) {
        const key = `${execution}-${start}`;
        submit({ key, booking: "second", start, end: start + 10, event: "second" });
        safe();
        assert.equal(outcome(key), "conflict");
      }
    }
    complete("move");
    assert.equal(
      submit({ key: "adjacent", booking: "second", start: 0, end: 10, event: "second" }),
      "accepted"
    );
    safe();
    assert.equal(
      submit({ key: "cancel", booking: "first", start: 10, end: 20, action: "cancel", version: 2 }),
      "accepted"
    );
    const count = (): unknown =>
      db
        .query<{ count: unknown }, []>(
          "SELECT count(*) AS count FROM booking_reservation WHERE booking_id='first'"
        )
        .get()?.count;
    assert.equal(count(), 1);
    complete("cancel");
    assert.equal(count(), 0);
    assert.equal(
      submit({ key: "adjacent", booking: "second", start: 0, end: 10, event: "second" }),
      "accepted"
    );
    safe();
    const version = db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version;
    process.stdout.write(
      `Bun ${Bun.version}, SQLite ${version}: real admission/finalization SQL witness passed\n`
    );
  } finally {
    db.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

function driftGate(): void {
  const skill = readFileSync(join(here, "../SKILL.md"), "utf8");
  const sync = /Sync commit: `([0-9a-f]{40})`/.exec(skill)?.[1];
  assert.ok(sync, "SKILL.md must record the reviewed sync commit.");
  const diff = command(["git", "diff", sync, "--", ...covered]);
  const untracked = command(["git", "ls-files", "--others", "--exclude-standard", "--", ...covered]);
  assert.ok(
    !diff && !untracked,
    "SOURCE DRIFT: read covered diffs and resync the model per SKILL.md before trusting TLC."
  );
}

async function tlc(): Promise<number> {
  const cache = join(root, ".verification/formal");
  mkdirSync(cache, { recursive: true });
  const jar = join(cache, "tla2tools.jar");
  if (!(await Bun.file(jar).exists())) {
    command([
      "gh",
      "release",
      "download",
      "v1.7.4",
      "--repo",
      "tlaplus/tlaplus",
      "--pattern",
      "tla2tools.jar",
      "--dir",
      cache,
    ]);
  }
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(jar).arrayBuffer()).digest("hex");
  assert.equal(digest, jarSha, "TLC jar SHA256 mismatch; inspect the pinned release, do not bypass.");
  const temporary = mkdtempSync(join(tmpdir(), "flare-formal-tlc-"));
  try {
    const result = Bun.spawnSync({
      cmd: [
        "java",
        "-XX:+UseParallelGC",
        "-jar",
        jar,
        "-workers",
        "1",
        "-metadir",
        temporary,
        "-config",
        join(here, "Reservations.cfg"),
        join(here, "Reservations.tla"),
      ],
      cwd: temporary,
      stdout: "inherit",
      stderr: "inherit",
    });
    return result.exitCode;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

sqlWitness();
driftGate();
process.exitCode = await tlc();
