import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getDMMF } from "@prisma/internals";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { domainSQLBody, generateD1Domain, getLogicalLists, persistD1Domain } from "./generate-d1-domain.mjs";
import { migrateD1 } from "./migrate-d1.mjs";

const execute = promisify(execFile);
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const iso = "2026-11-05T12:34:56.789+00:00";
const { version } = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("prisma/package.json"));
let postgres: Awaited<ReturnType<typeof generateD1Domain>>;
let generated: Awaited<ReturnType<typeof generateD1Domain>>;
let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let oracle: typeof db;
let migrationCount: number;

beforeAll(async () => {
  postgres = await generateD1Domain();
  generated = await generateD1Domain({ source: postgres.candidate });
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
    // 0005 seeds OutOfOfficeReason id 1, which the per-model fixture reuses for FK targets.
    return db
      .prepare(
        `INSERT OR REPLACE INTO ${q(model.dbName ?? model.name)} (${fields.map((f) => q(f.dbName ?? f.name)).join(",")}) VALUES (${fields.map(() => "?").join(",")})`
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
  it("preserves reviewed migration bytes across tool upgrades and rejects SQL or provenance drift", async () => {
    const path = await mkdtemp(join(root, "history-"));
    const directory = pathToFileURL(`${path}/`);
    const reviewed = await Promise.all(
      generated.migrations.map(async ({ name }) => ({
        name,
        sql: await readFile(new URL(`./migrations-d1/${name}`, import.meta.url), "utf8"),
      }))
    );
    for (const { name, sql } of reviewed) await writeFile(new URL(name, directory), sql);
    for (const check of [true, false]) {
      await persistD1Domain({ migrations: generated.migrations, directory, check });
      for (const mutate of [
        (sql: string) =>
          sql.replace("BETWEEN -2147483648 AND 2147483647", "BETWEEN -2147483648 AND 2147483648"),
        (sql: string) => sql.replace(`; Prisma ${version}.`, "; Prisma 0.0.0."),
        (sql: string) => sql.replace(/SHA-256: [a-f0-9]{64}/, `SHA-256: ${"0".repeat(64)}`),
      ]) {
        const migrations = generated.migrations.map((migration, index) => ({
          ...migration,
          sql: index === 0 ? mutate(migration.sql) : migration.sql,
        }));
        await expect(persistD1Domain({ migrations, directory, check })).rejects.toThrow(/D1 domain SQL/);
      }
    }
    for (const { name, sql } of reviewed) expect(await readFile(new URL(name, directory), "utf8")).toBe(sql);
    await writeFile(
      new URL(reviewed[0].name, directory),
      reviewed[0].sql.replace("Prisma 6.16.1", "Prisma 0.0.0")
    );
    await expect(persistD1Domain({ migrations: generated.migrations, directory })).rejects.toThrow(
      /provenance/
    );
  });

  it("creates only missing files after all existing migrations pass validation", async () => {
    const path = await mkdtemp(join(root, "fresh-"));
    const directory = pathToFileURL(`${path}/`);
    const last = generated.migrations[generated.migrations.length - 1];
    await writeFile(new URL(last.name, directory), `${last.sql}-- drift\n`);
    await expect(persistD1Domain({ migrations: generated.migrations, directory })).rejects.toThrow(
      /D1 domain SQL/
    );
    expect(await readdir(path)).toEqual([last.name]);
    await writeFile(new URL(last.name, directory), last.sql);
    await expect(
      persistD1Domain({ migrations: generated.migrations, directory, check: true })
    ).rejects.toThrow();
    await persistD1Domain({ migrations: generated.migrations, directory });
    await persistD1Domain({ migrations: generated.migrations, directory, check: true });
    for (const { name, sql } of generated.migrations)
      expect(await readFile(new URL(name, directory), "utf8")).toBe(sql);
  });

  it("reproduces reviewed SQL and matches every source table, column, FK, and index", async () => {
    const reviewedHashes = {
      "0001_holiday_cache.sql": "e7348a99ae03b4cfb3151c3270a2292dfae13c1a5726d03cd25e2877d32206e3",
      "0002_domain_tables.sql": "47cc828bd1eedbb6466fa3354f151aabd69c38ae0a6261166cf298cc9d91cbf9",
      "0003_domain_tables.sql": "c0f192039ed17de1424ec9fb2f902b7f458e639090ce14b25c295568137a7a11",
      "0004_auth.sql": "7139daefe8968179b248959210cc97fe30a9a829ca65278b3fc758b9778b9a04",
    };
    for (const [name, hash] of Object.entries(reviewedHashes))
      expect(
        createHash("sha256")
          .update(await readFile(new URL(`./migrations-d1/${name}`, import.meta.url)))
          .digest("hex")
      ).toBe(hash);
    for (const { name, sql } of generated.migrations) {
      const historical = await readFile(new URL(`./migrations-d1/${name}`, import.meta.url), "utf8");
      expect(historical).toContain("; Prisma 6.16.1.\n");
      expect(sql).toContain(`; Prisma ${version}.\n`);
      expect(sql).toContain(
        `SHA-256: ${generated.migrations.find((item) => item.name === name)?.sourceHash}`
      );
      expect(domainSQLBody(postgres.migrations.find((migration) => migration.name === name)?.sql ?? "")).toBe(
        domainSQLBody(historical)
      );
      expect(domainSQLBody(sql)).toBe(domainSQLBody(historical));
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
    for (const { model, field, elementType } of generated.listFields) {
      const table = q(model.dbName ?? model.name);
      const column = q(field.dbName ?? field.name);
      const values =
        elementType === "Int"
          ? [0, -1, 2147483647]
          : (generated.enums.get(elementType) ?? ["é/日本語", "", "duplicate", "duplicate"]);
      for (const value of [JSON.stringify(values), "[]", null]) {
        await db.prepare(`UPDATE ${table} SET ${column}=?`).bind(value).run();
        expect(await db.prepare(`SELECT ${column} AS value FROM ${table}`).first("value")).toBe(value);
      }
      const invalidElement = elementType === "Int" ? "[1.5]" : "[1]";
      const invalid = ["{", "{}", '"text"', "null", "[null]", "[[]]", invalidElement];
      if (generated.enums.has(elementType)) invalid.push('["unknown"]');
      if (elementType === "Int") invalid.push("[2147483648]");
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
      for (const field of model.fields.filter(
        (field) => field.type === "Json" && !generated.listFields.some((list) => list.field === field)
      )) {
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

describe("D1 list metadata and historical provenance", () => {
  it("keeps all original migration bytes and complete physical SQL constraints", async () => {
    const hashes = [
      "e7348a99ae03b4cfb3151c3270a2292dfae13c1a5726d03cd25e2877d32206e3",
      "47cc828bd1eedbb6466fa3354f151aabd69c38ae0a6261166cf298cc9d91cbf9",
      "c0f192039ed17de1424ec9fb2f902b7f458e639090ce14b25c295568137a7a11",
      "7139daefe8968179b248959210cc97fe30a9a829ca65278b3fc758b9778b9a04",
      "53bf18e310512b7b2915e0bb1b57e7b134335eac926c6e1333a35beaf3affd23",
    ];
    const names = (await readdir(new URL("./migrations-d1/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(
      await Promise.all(
        names.map(async (name) =>
          createHash("sha256")
            .update(await readFile(new URL(`./migrations-d1/${name}`, import.meta.url)))
            .digest("hex")
        )
      )
    ).toEqual(hashes);
    const sql = generated.migrations.map(({ sql }) => sql).join("\n");
    expect(sql.match(/CREATE TRIGGER /g)).toHaveLength(18);
    expect(sql.match(/FOREIGN KEY /g)).toHaveLength(179);
    expect(generated.oracle.match(/DEFAULT \(strftime/g)).toHaveLength(72);
    expect(generated.oracle.match(/CREATE UNIQUE INDEX /g)).toHaveLength(107);
    expect(generated.oracle.match(/CREATE INDEX /g)).toHaveLength(183);
    expect(
      generated.models.map((model) => [
        model.name,
        model.dbName,
        model.fields.map((field) => [
          field.name,
          field.dbName,
          field.relationName,
          field.relationFromFields,
          field.relationToFields,
        ]),
      ])
    ).toEqual(
      postgres.models.map((model) => [
        model.name,
        model.dbName,
        model.fields.map((field) => [
          field.name,
          field.dbName,
          field.relationName,
          field.relationFromFields,
          field.relationToFields,
        ]),
      ])
    );
    expect(
      generated.listFields.map(({ model, field, elementType }) => [model.name, field.name, elementType])
    ).toEqual(
      postgres.listFields.map(({ model, field, elementType }) => [model.name, field.name, elementType])
    );
    for (const { field } of generated.listFields)
      expect(field).toMatchObject({
        type: "Json",
        kind: "scalar",
        isRequired: false,
        isList: false,
        hasDefaultValue: false,
      });
    await persistD1Domain({ migrations: postgres.migrations, check: true });
    await persistD1Domain({ migrations: generated.migrations, check: true });
  });

  it.each([
    ["dropped", ""],
    ["wrong element", "/// @calflare.list String"],
  ])(
    "rejects %s list contracts against reviewed history",
    async (_name, annotation) => {
      const weakened = await generateD1Domain({
        source: postgres.candidate.replace("/// @calflare.list Int", annotation),
      });
      await expect(persistD1Domain({ migrations: weakened.migrations, check: true })).rejects.toThrow(
        /append a reviewed migration/
      );
    },
    30_000
  );

  it("preserves historical SHA on generation while rejecting SQL or version drift before writing", async () => {
    const directoryPath = await mkdtemp(join(root, "history-"));
    const directory = pathToFileURL(`${directoryPath}/`);
    await persistD1Domain({ migrations: postgres.migrations, directory });
    await persistD1Domain({ migrations: generated.migrations, directory });
    for (const { name, sql } of postgres.migrations)
      expect(await readFile(new URL(name, directory), "utf8")).toBe(sql);
    for (const check of [true, false]) {
      const mutations = [
        (sql: string) =>
          sql.replace("BETWEEN -2147483648 AND 2147483647", "BETWEEN -2147483648 AND 2147483648"),
        (sql: string) => sql.replace(`Prisma ${version}`, "Prisma 0.0.0"),
        (sql: string) => sql.replace(/SHA-256: [a-f0-9]{64}/, "SHA-256: invalid"),
      ];
      for (const mutate of mutations) {
        const migrations = generated.migrations.map((migration, index) => ({
          ...migration,
          sql: index === 0 ? mutate(migration.sql) : migration.sql,
        }));
        await expect(persistD1Domain({ migrations, directory, check })).rejects.toThrow(/D1 domain SQL/);
      }
    }
    for (const { name, sql } of postgres.migrations)
      expect(await readFile(new URL(name, directory), "utf8")).toBe(sql);
  });

  const metadata = async (field: string, provider = "sqlite") => {
    const { datamodel } = await getDMMF({
      datamodel: `
      datasource db {
        provider = "${provider}"
        url = "file:unused.db"
      }
      enum Element {
        VALUE @map("persisted-value")
      }
      model Fixture {
        id Int @id
        ${field}
      }
    `,
    });
    return getLogicalLists(
      datamodel.models,
      new Map(
        datamodel.enums.map((item) => [item.name, item.values.map((value) => value.dbName ?? value.name)])
      )
    );
  };

  it("uses canonical enum persisted values without falsifying Json metadata", async () => {
    const lists = await metadata('/// @calflare.list Element\nvalues Json? @map("mapped_values")');
    expect(lists[0]).toMatchObject({
      elementType: "Element",
      field: { type: "Json", kind: "scalar", dbName: "mapped_values" },
    });
    const quoted = "@db.Text @default(now())";
    const documentation = "/// DateTime @db.Timestamp(3) @default(now())";
    const mapped = await generateD1Domain({
      source: postgres.candidate
        .replace("BOOKING_CREATED\n", 'BOOKING_CREATED @map("booking-created")\n')
        .replace('"Europe/London"', JSON.stringify(quoted))
        .replace("/// @calflare.list Int", `${documentation}\n  /// @calflare.list Int`),
    });
    expect(mapped.candidate).toContain(JSON.stringify(quoted));
    expect(mapped.candidate).toContain(documentation);
    expect(mapped.enums.get("WebhookTriggerEvents")).toContain("booking-created");
    expect(mapped.migrations.map(({ sql }) => sql).join("\n")).toContain("value NOT IN ('booking-created'");
  }, 30_000);

  it.each([
    "/// @calflare.list MissingEnum\nvalues Json?",
    "/// @calflare.list Boolean\nvalues Json?",
    "/// @calflare.list Int[]\nvalues Json?",
    "/// @calflare.list Int\n/// @calflare.list String\nvalues Json?",
    "/// @calflare.list Int\nvalues String?",
    "/// @calflare.list Int\nvalues Json",
    '/// @calflare.list Int\nvalues Json? @default("[]")',
  ])("rejects invalid or conflicting annotation %s", async (field) => {
    await expect(metadata(field)).rejects.toThrow(/list (metadata|element type)/);
  });

  it("rejects annotations conflicting with actual scalar lists", async () => {
    await expect(metadata("/// @calflare.list Int\nvalues String[]", "postgresql")).rejects.toThrow(
      /Invalid list metadata/
    );
  });
});
