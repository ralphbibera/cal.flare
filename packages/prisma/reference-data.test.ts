import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pin from "./fixtures/pin-reference-data.json";
import { migrateD1 } from "./migrate-d1.mjs";

const d1Date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let root: string;
let persistTo: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

const rows = async (sql: string, ...params: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>()
  ).results;
const sortTuples = (tuples: string[][]) =>
  [...tuples].sort((a, b) => a.join("\0").localeCompare(b.join("\0")));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-reference-data-test-"));
  persistTo = join(root, "state");
  const total = (await readdir(new URL("./migrations-d1/", import.meta.url))).filter((name) =>
    name.endsWith(".sql")
  ).length;
  expect(await migrateD1({ persistTo })).toMatchObject({ applied: total, total });
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
  db = await mf.getD1Database("DB");
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("D1 reference data", () => {
  it("matches the PostgreSQL end-state of every pinned migration", async () => {
    expect(
      await rows(`SELECT "id","name","description","teamId","type","color" FROM "Role" ORDER BY "id"`)
    ).toEqual(pin.Role);
    const permissions = await rows(
      `SELECT "id","roleId","resource","action","createdAt" FROM "RolePermission"`
    );
    expect(sortTuples(permissions.map((row) => [row.roleId, row.resource, row.action].map(String)))).toEqual(
      sortTuples(pin.RolePermission)
    );
    expect(new Set(permissions.map((row) => row.id)).size).toBe(89);
    for (const row of permissions) {
      expect(row.id).toMatch(uuidV4);
      expect(row.createdAt).toMatch(d1Date);
    }
    expect(
      await rows(
        `SELECT "slug","enabled","type","description","stale","lastUsedAt","updatedBy" FROM "Feature" ORDER BY "slug"`
      )
    ).toEqual(pin.Feature);
    expect(
      await rows(`SELECT "id","emoji","reason","enabled","userId" FROM "OutOfOfficeReason" ORDER BY "id"`)
    ).toEqual(pin.OutOfOfficeReason);
    expect(await rows(`SELECT "slug","dirName","keys","categories","enabled" FROM "App"`)).toEqual(pin.App);
    expect(
      await rows(
        `SELECT "id","type","userUuid","attendeeId","credentialId","email","phone","name" FROM "AuditActor"`
      )
    ).toEqual(pin.AuditActor);
    for (const [table, columns] of [
      ["Role", ["createdAt", "updatedAt"]],
      ["Feature", ["createdAt", "updatedAt"]],
      ["App", ["createdAt", "updatedAt"]],
      ["AuditActor", ["createdAt"]],
    ] as const)
      for (const row of await rows(`SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM "${table}"`))
        for (const column of columns) expect(row[column]).toMatch(d1Date);
    expect(await migrateD1({ persistTo })).toMatchObject({ applied: 0 });
  });

  it("sets Membership.customRoleId from role on insert and role updates as the PostgreSQL trigger did", async () => {
    await db.batch([
      db.prepare(`INSERT INTO "Team" ("id","name") VALUES (1,'team')`),
      db.prepare(
        `INSERT INTO "users" ("id","email","username","uuid") VALUES (1,'a@example.com','a','u1'),(2,'b@example.com','b','u2')`
      ),
    ]);
    const customRoleId = async (id: number) =>
      (await rows(`SELECT "customRoleId" FROM "Membership" WHERE "id" = ?`, id))[0]?.customRoleId;
    const write = (sql: string) => db.prepare(sql).run();

    await write(
      `INSERT INTO "Membership" ("id","teamId","userId","role","customRoleId") VALUES (1,1,1,'OWNER','member_role')`
    );
    expect(await customRoleId(1)).toBe("owner_role");
    await write(`INSERT INTO "Membership" ("id","teamId","userId","role") VALUES (2,1,2,'MEMBER')`);
    expect(await customRoleId(2)).toBe("member_role");
    await write(`UPDATE "Membership" SET "role" = 'ADMIN' WHERE "id" = 1`);
    expect(await customRoleId(1)).toBe("admin_role");
    await write(`UPDATE "Membership" SET "customRoleId" = NULL WHERE "id" = 1`);
    expect(await customRoleId(1)).toBeNull();
    await write(`UPDATE "Membership" SET "accepted" = true WHERE "id" = 1`);
    expect(await customRoleId(1)).toBeNull();
    await write(`UPDATE "Membership" SET "role" = 'MEMBER', "customRoleId" = 'owner_role' WHERE "id" = 1`);
    expect(await customRoleId(1)).toBe("member_role");
    await write(`UPDATE "Membership" SET "customRoleId" = NULL WHERE "id" = 2`);
    await write(`UPDATE "Membership" SET "role" = "role" WHERE "id" = 2`);
    expect(await customRoleId(2)).toBe("member_role");
  });
});
