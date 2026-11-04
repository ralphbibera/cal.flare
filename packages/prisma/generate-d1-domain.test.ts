import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { generateD1Domain } from "./generate-d1-domain.mjs";
import { migrateD1 } from "./migrate-d1.mjs";

const execute = promisify(execFile);
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const iso = "2026-11-05T12:34:56.789+00:00";
let generated: Awaited<ReturnType<typeof generateD1Domain>>;
let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let oracle: typeof db;
let migrationCount: number;

beforeAll(async () => {
  generated = await generateD1Domain();
  root = await mkdtemp(join(tmpdir(), "calflare-domain-test-"));
  const persistTo = join(root, "state");
  const { stdout } = await execute("bun", [
    "run",
    "--cwd",
    fileURLToPath(new URL("./", import.meta.url)),
    "db-deploy:d1",
    "--local-only",
    "--persist-to",
    persistTo,
  ]);
  migrationCount = (await readdir(new URL("./migrations-d1/", import.meta.url))).filter((name) =>
    name.endsWith(".sql")
  ).length;
  const total = migrationCount;
  expect(JSON.parse(stdout)).toMatchObject({ applied: total, total, database: "DB-calflare-web" });
  expect(await migrateD1({ persistTo })).toMatchObject({ applied: 0, total });
  const { worker } = (await import("../../apps/web/cloudflare.config")).default;
  mf = new Miniflare({
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
          env: { DB: worker.env.DB, ORACLE: { type: "d1", name: "domain-oracle", dev: { remote: false } } },
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
  db = await mf.getD1Database("DB");
  oracle = await mf.getD1Database("ORACLE");
  await oracle.batch(
    generated.oracle
      .split(/(?=^-- CreateTable|^-- CreateIndex)/m)
      .filter((sql) => sql.trim())
      .map((sql) => oracle.prepare(sql))
  );
  const referenced = new Set(
    generated.models.flatMap((model) =>
      model.fields.flatMap((field) => (field.relationToFields ?? []).map((name) => `${field.type}.${name}`))
    )
  );
  const inserts = generated.models.map((model) => {
    const fields = model.fields.filter(
      (field) =>
        field.kind !== "object" &&
        (field.isId || referenced.has(`${model.name}.${field.name}`) || (field.isRequired && !field.isList))
    );
    const values = fields.map((field) => {
      if (field.isList) return "[]";
      if (field.kind === "enum") return generated.enums.get(field.type)?.[0] ?? "";
      if (["Int", "BigInt", "Float"].includes(field.type)) return 1;
      if (field.type === "Boolean") return 0;
      if (field.type === "DateTime") return iso;
      if (field.type === "Json") return "{}";
      return "fixture";
    });
    return db
      .prepare(
        `INSERT INTO ${q(model.dbName ?? model.name)} (${fields.map((f) => q(f.dbName ?? f.name)).join(",")}) VALUES (${fields.map(() => "?").join(",")})`
      )
      .bind(...values);
  });
  await db.batch([db.prepare("PRAGMA defer_foreign_keys=ON"), ...inserts]);
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("D1 domain storage", () => {
  it("reproduces reviewed SQL and matches every source table, column, FK, and index", async () => {
    for (const { name, sql } of generated.migrations) {
      expect(sql).toBe(await readFile(new URL(`./migrations-d1/${name}`, import.meta.url), "utf8"));
      expect(Buffer.byteLength(sql)).toBeLessThan(100_000);
    }
    const tables = z
      .array(z.object({ name: z.string() }))
      .parse(
        (
          await oracle
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY name"
            )
            .all()
        ).results
      );
    expect(tables).toHaveLength(102);
    const migratedTables = z
      .array(z.object({ name: z.string() }))
      .parse(
        (
          await db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA','_calflare_migrations') ORDER BY name"
            )
            .all()
        ).results
      );
    const domainNames = new Set(tables.map(({ name }) => name));
    expect(migratedTables.filter(({ name }) => domainNames.has(name))).toEqual(tables);
    for (const { name } of tables) {
      for (const pragma of ["table_info", "foreign_key_list", "index_list"]) {
        const sql = `PRAGMA ${pragma}(${q(name)})`;
        const normalize = (rows: object[]) =>
          rows
            .map((row) =>
              Object.fromEntries(
                Object.entries(row)
                  .filter(([key]) => key !== "seq")
                  .map(([key, value]) => [key, key === "type" && value === "JSONB" ? "TEXT" : value])
              )
            )
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        expect(normalize((await db.prepare(sql).all()).results), `${name}.${pragma}`).toEqual(
          normalize((await oracle.prepare(sql).all()).results)
        );
      }
    }
    const indexes = z
      .array(z.object({ name: z.string() }))
      .parse(
        (await oracle.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all())
          .results
      );
    for (const { name } of indexes) {
      const sql = `PRAGMA index_xinfo(${q(name)})`;
      expect((await db.prepare(sql).all()).results).toEqual((await oracle.prepare(sql).all()).results);
    }
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM _calflare_migrations").first())?.count).toBe(
      migrationCount
    );
  });

  it("round trips all nine typed arrays, rejecting malformed storage on insert and update", async () => {
    expect(generated.listFields).toHaveLength(9);
    for (const { model, field } of generated.listFields) {
      const table = q(model.dbName ?? model.name);
      const column = q(field.dbName ?? field.name);
      const values =
        field.type === "Int"
          ? [0, -1, 2147483647]
          : (generated.enums.get(field.type) ?? ["é/日本語", "", "duplicate", "duplicate"]);
      for (const value of [JSON.stringify(values), "[]", null]) {
        await db.prepare(`UPDATE ${table} SET ${column}=?`).bind(value).run();
        expect(await db.prepare(`SELECT ${column} AS value FROM ${table}`).first("value")).toBe(value);
      }
      const invalidElement = field.type === "Int" ? "[1.5]" : "[1]";
      const invalid = ["{", "{}", '"text"', "null", "[null]", "[[]]", invalidElement];
      if (field.kind === "enum") invalid.push('["unknown"]');
      if (field.type === "Int") invalid.push("[2147483648]");
      for (const value of invalid) {
        await expect(db.prepare(`UPDATE ${table} SET ${column}=?`).bind(value).run()).rejects.toThrow(/list/);
        await expect(
          db.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`).bind(value).run()
        ).rejects.toThrow(/list/);
      }
      expect(await db.prepare(`SELECT ${column} AS value FROM ${table}`).first("value")).toBeNull();
    }
  });

  it("enforces every persisted enum column using mapped values and preserves nullable enums", async () => {
    let count = 0;
    for (const model of generated.models) {
      for (const field of model.fields.filter((field) => field.kind === "enum" && !field.isList)) {
        count++;
        const table = q(model.dbName ?? model.name);
        const column = q(field.dbName ?? field.name);
        const original = await db.prepare(`SELECT ${column} AS value FROM ${table}`).first("value");
        for (const value of generated.enums.get(field.type) ?? []) {
          await db.prepare(`UPDATE ${table} SET ${column}=?`).bind(value).run();
          expect(await db.prepare(`SELECT ${column} AS value FROM ${table}`).first("value")).toBe(value);
        }
        await expect(db.prepare(`UPDATE ${table} SET ${column}='invalid-enum'`).run()).rejects.toThrow(
          /CHECK/
        );
        if (!field.isRequired) await db.prepare(`UPDATE ${table} SET ${column}=NULL`).run();
        await db.prepare(`UPDATE ${table} SET ${column}=?`).bind(original).run();
      }
    }
    expect(count).toBe(52);
  });

  it("retains raw JSON scalars, JSON null and SQL null without imposing object shapes", async () => {
    for (const model of generated.models) {
      for (const field of model.fields.filter((field) => field.type === "Json")) {
        const table = q(model.dbName ?? model.name);
        const column = q(field.dbName ?? field.name);
        const original = await db.prepare(`SELECT ${column} AS value FROM ${table}`).first("value");
        for (const value of [
          '{"é":[null,1]}',
          "[]",
          '"日本語"',
          "42",
          "9223372036854775808",
          "1.23000",
          "1e1000",
          "true",
          "null",
        ]) {
          await db.prepare(`UPDATE ${table} SET ${column}=?`).bind(value).run();
          expect(await db.prepare(`SELECT ${column} AS value FROM ${table}`).first("value")).toBe(value);
        }
        await expect(db.prepare(`UPDATE ${table} SET ${column}='{'`).run()).rejects.toThrow(/CHECK/);
        if (!field.isRequired) await db.prepare(`UPDATE ${table} SET ${column}=NULL`).run();
        await db.prepare(`UPDATE ${table} SET ${column}=?`).bind(original).run();
      }
    }
  });

  it("keeps date defaults, nullable uniqueness, IDs, required fields and cascading FKs", async () => {
    await db
      .prepare(
        'INSERT INTO users (id,uuid,email) VALUES (100,"manual-id","a@example.invalid"),(101,"second-id","b@example.invalid")'
      )
      .run();
    const created = await db
      .prepare("SELECT created, timeZone, bufferTime, hideBranding FROM users WHERE id=100")
      .first();
    expect(created).toMatchObject({ timeZone: "Europe/London", bufferTime: 0, hideBranding: 0 });
    expect(created?.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/);
    await expect(db.prepare('INSERT INTO users (uuid) VALUES ("missing-email")').run()).rejects.toThrow(
      /NOT NULL/
    );
    await expect(
      db.prepare('INSERT INTO users (uuid,email) VALUES ("manual-id","duplicate@example.invalid")').run()
    ).rejects.toThrow(/UNIQUE/);
    await db.prepare("UPDATE users SET username='shared-null-org' WHERE id IN (100,101)").run();
    await db.prepare("UPDATE users SET organizationId=1 WHERE id=100").run();
    await expect(db.prepare("UPDATE users SET organizationId=1 WHERE id=101").run()).rejects.toThrow(
      /UNIQUE/
    );
    await db.prepare('INSERT INTO users (uuid,email) VALUES ("auto-id","auto@example.invalid")').run();
    expect(await db.prepare("SELECT id FROM users WHERE uuid='auto-id'").first("id")).toBe(102);
    await expect(db.prepare("UPDATE users SET bufferTime=2147483648 WHERE id=100").run()).rejects.toThrow(
      /CHECK/
    );
    await expect(db.prepare("UPDATE users SET hideBranding=2 WHERE id=100").run()).rejects.toThrow(/CHECK/);
    await expect(
      db.prepare('INSERT INTO "UserHolidaySettings" (userId,updatedAt) VALUES (-999,?)').bind(iso).run()
    ).rejects.toThrow(/FOREIGN KEY/);
    await db.prepare('INSERT INTO "UserHolidaySettings" (userId,updatedAt) VALUES (100,?)').bind(iso).run();
    await db.prepare("DELETE FROM users WHERE id=100").run();
    expect(
      await db.prepare('SELECT COUNT(*) FROM "UserHolidaySettings" WHERE userId=100').first("COUNT(*)")
    ).toBe(0);
    await db
      .prepare('UPDATE "Availability" SET startTime=?,endTime=?,date=?')
      .bind("1970-01-01T09:30:00.000+00:00", "1970-01-01T10:45:00.000+00:00", "2026-11-05T00:00:00.000+00:00")
      .run();
    expect(await db.prepare('SELECT startTime,date FROM "Availability"').first()).toEqual({
      startTime: "1970-01-01T09:30:00.000+00:00",
      date: "2026-11-05T00:00:00.000+00:00",
    });
  });
});
