import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateD1 } from "./migrate-d1.mjs";

const execute = promisify(execFile);
const runner = fileURLToPath(new URL("./migrate-d1.mts", import.meta.url));
const configUrl = new URL("../../apps/web/cloudflare.config.ts", import.meta.url);
let root: string;
let migrationsDirectory: string;
let persistTo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-d1-migrations-test-"));
  migrationsDirectory = join(root, "migrations");
  persistTo = join(root, "state");
  await mkdir(migrationsDirectory);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const migrate = () => migrateD1({ migrationsDirectory, persistTo });
const migration = (name: string, sql: string) => writeFile(join(migrationsDirectory, name), sql);

async function readDatabase(sql: string) {
  const { worker } = (await import(configUrl.href)).default;
  const mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(persistTo, "v3"),
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: { DB: worker.env.DB },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database("DB");
    return await db.prepare(sql).all();
  } finally {
    await mf.dispose();
  }
}

describe("D1 migration history", () => {
  it("applies real SQL files and triggers once, sharing the web binding's persisted database", async () => {
    const holiday = await readFile(
      new URL("./migrations-d1/0001_holiday_cache.sql", import.meta.url),
      "utf8"
    );
    await migration("0001_holiday_cache.sql", holiday);
    await migration(
      "0002_audit.sql",
      `CREATE TABLE audit (value TEXT);
       CREATE TRIGGER holiday_audit AFTER INSERT ON "HolidayCache" BEGIN
         INSERT INTO audit VALUES ('first;value'); -- quoted ; and comment ;
         INSERT INTO audit VALUES ('it''s;second');
       END;
       /* block ; comment */
       INSERT INTO "HolidayCache" (id,countryCode,calendarId,eventId,name,date,year,updatedAt)
       VALUES ('id','US','cal','event','holiday;name','2026-01-01T00:00:00.000+00:00',2026,'2026-01-01T00:00:00.000+00:00');`
    );
    expect(await migrate()).toMatchObject({
      applied: 2,
      total: 2,
      database: "DB-calflare-web",
      persistence: persistTo,
    });
    expect((await readDatabase("SELECT value FROM audit ORDER BY rowid")).results).toEqual([
      { value: "first;value" },
      { value: "it's;second" },
    ]);
    const history = await readDatabase(
      "SELECT position,name,hash,applied_at FROM _calflare_migrations ORDER BY position"
    );
    expect(history.results).toHaveLength(2);
    expect(history.results[0]).toMatchObject({
      position: 1,
      name: "0001_holiday_cache.sql",
      hash: createHash("sha256").update(holiday).digest("hex"),
    });
    expect(await migrate()).toMatchObject({ applied: 0, total: 2 });
    expect(
      (await readDatabase("SELECT position,name,hash,applied_at FROM _calflare_migrations ORDER BY position"))
        .results
    ).toEqual(history.results);
    expect((await readDatabase("SELECT COUNT(*) AS count FROM audit")).results).toEqual([{ count: 2 }]);
  });

  it("rejects edited, missing, or reordered applied SQL before applying pending files", async () => {
    const sql = "CREATE TABLE original (id INTEGER);";
    await migration("0001_original.sql", sql);
    await migrate();
    await migration("0002_pending.sql", "CREATE TABLE pending (id INTEGER);");
    await migration("0001_original.sql", `${sql}\n-- edited`);
    await expect(migrate()).rejects.toThrow("history/checksum mismatch: 0001_original.sql");
    await rm(join(migrationsDirectory, "0001_original.sql"));
    await expect(migrate()).rejects.toThrow("history/checksum mismatch: 0001_original.sql");
    await migration("0001_original.sql", sql);
    await migration("0000_before.sql", "CREATE TABLE before (id INTEGER);");
    await expect(migrate()).rejects.toThrow("history/checksum mismatch: 0001_original.sql");
    expect(
      (await readDatabase("SELECT name FROM sqlite_master WHERE name IN ('pending','before')")).results
    ).toEqual([]);
    expect((await readDatabase("SELECT COUNT(*) AS count FROM _calflare_migrations")).results).toEqual([
      { count: 1 },
    ]);
  });

  it("rolls back earlier statements and history on a later SQL failure, then resumes", async () => {
    await migration(
      "0001_original.sql",
      "CREATE TABLE original (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO original VALUES (1,'old');"
    );
    await migrate();
    const pending = `UPDATE original SET value='partial';
      CREATE TABLE partial (id INTEGER);
      INSERT INTO original VALUES (2,'partial');`;
    await migration("0002_pending.sql", `${pending}\nINSERT INTO missing VALUES (1);`);
    await expect(migrate()).rejects.toThrow("no such table: missing");
    expect((await readDatabase("SELECT * FROM original")).results).toEqual([{ id: 1, value: "old" }]);
    expect((await readDatabase("SELECT name FROM sqlite_master WHERE name='partial'")).results).toEqual([]);
    expect((await readDatabase("SELECT name FROM _calflare_migrations ORDER BY position")).results).toEqual([
      { name: "0001_original.sql" },
    ]);
    await migration("0002_pending.sql", pending);
    expect(await migrate()).toMatchObject({ applied: 1, total: 2 });
    expect((await readDatabase("SELECT * FROM original ORDER BY id")).results).toEqual([
      { id: 1, value: "partial" },
      { id: 2, value: "partial" },
    ]);
  });

  it("rolls back domain changes when the history insert fails", async () => {
    await migration(
      "0001_original.sql",
      `CREATE TABLE original (id INTEGER);
      CREATE TRIGGER reject_history BEFORE INSERT ON _calflare_migrations
      BEGIN SELECT RAISE(ABORT, 'history rejected'); END;`
    );
    await expect(migrate()).rejects.toThrow("history rejected");
    expect(
      (await readDatabase("SELECT name FROM sqlite_master WHERE name IN ('original','reject_history')"))
        .results
    ).toEqual([]);
    expect((await readDatabase("SELECT * FROM _calflare_migrations")).results).toEqual([]);
  });

  it("runs the opt-in command only with an explicit local target", async () => {
    for (const args of [[], ["--remote"], ["--local-only", "--remote"]]) {
      await expect(
        execute("bun", [runner, ...args, "--persist-to", persistTo], { cwd: root })
      ).rejects.toThrow();
    }
    expect(await readdir(root)).toEqual(["migrations"]);
    const { stdout } = await execute(
      "bun",
      [
        "run",
        "--cwd",
        fileURLToPath(new URL("./", import.meta.url)),
        "db-deploy:d1",
        "--local-only",
        "--persist-to",
        persistTo,
      ],
      { cwd: root }
    );
    const migrationNames = (await readdir(new URL("./migrations-d1/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(JSON.parse(stdout)).toMatchObject({
      applied: migrationNames.length,
      database: "DB-calflare-web",
      persistence: persistTo,
    });
    expect((await readDatabase("SELECT name FROM _calflare_migrations ORDER BY position")).results).toEqual(
      migrationNames.map((name) => ({ name }))
    );
  });
});
