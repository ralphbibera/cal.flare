import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeEventTypeHostGroupsInD1 } from "./eventTypeHostGroupsInD1";

const GROUP_UPDATED = "11111111-1111-4111-8111-111111111111";
const GROUP_DELETED = "22222222-2222-4222-8222-222222222222";
const GROUP_KEPT = "33333333-3333-4333-8333-333333333333";
const GROUP_CREATED = "44444444-4444-4444-8444-444444444444";
const GROUP_OTHER_CREATED = "55555555-5555-4555-8555-555555555555";
const GROUP_MISSING = "99999999-9999-4999-8999-999999999999";
const SEEDED_AT = "2026-11-05T00:00:00.000+00:00";

describe("event type host groups on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  const write = (input: {
    eventTypeId?: number;
    groupsToCreate?: { id: string; name: string }[];
    groupsToUpdate?: { id: string; name: string }[];
    groupsToDelete?: { id: string }[];
  }): Promise<void> =>
    withD1Database({ DB: db }, () =>
      writeEventTypeHostGroupsInD1({
        eventTypeId: 1,
        groupsToCreate: [],
        groupsToUpdate: [],
        groupsToDelete: [],
        ...input,
      })
    );

  const group = (
    id: string
  ): Promise<{ name: string; eventTypeId: number | null; updatedAt: string } | null> =>
    db
      .prepare('SELECT "name", "eventTypeId", "updatedAt" FROM "HostGroup" WHERE "id" = ?')
      .bind(id)
      .first<{ name: string; eventTypeId: number | null; updatedAt: string }>();
  const groupCount = async (): Promise<number | undefined> =>
    (await db.prepare('SELECT COUNT(*) AS "count" FROM "HostGroup"').first<{ count: number }>())?.count;
  const hostGroupId = (userId: number, eventTypeId: number): Promise<{ groupId: string | null } | null> =>
    db
      .prepare('SELECT "groupId" FROM "Host" WHERE "userId" = ? AND "eventTypeId" = ?')
      .bind(userId, eventTypeId)
      .first<{ groupId: string | null }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-host-groups-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
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
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS "fail_group_delete"'),
      db.prepare('DELETE FROM "Host"'),
      db.prepare('DELETE FROM "HostGroup"'),
      db.prepare('DELETE FROM "EventType"'),
      db.prepare('DELETE FROM "users"'),
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES
          (1, 'user-1', 'one@example.invalid'),
          (2, 'user-2', 'two@example.invalid'),
          (3, 'user-3', 'three@example.invalid')`
      ),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length") VALUES
          (1, 'Host groups', 'host-groups', 30),
          (2, 'Other event', 'other-event', 30)`
      ),
      db
        .prepare(
          `INSERT INTO "HostGroup" ("id", "name", "eventTypeId", "updatedAt") VALUES
            (?, 'Updated', 1, ?),
            (?, 'Deleted', 1, ?),
            (?, 'Kept', 1, ?)`
        )
        .bind(GROUP_UPDATED, SEEDED_AT, GROUP_DELETED, SEEDED_AT, GROUP_KEPT, SEEDED_AT),
      db
        .prepare(
          `INSERT INTO "Host" ("userId", "eventTypeId", "groupId") VALUES (1, 1, ?), (2, 1, ?), (3, 2, NULL)`
        )
        .bind(GROUP_UPDATED, GROUP_DELETED),
    ]);
  });

  it("commits creates, updates and deletes together", async () => {
    await write({
      groupsToCreate: [{ id: GROUP_CREATED, name: "Created" }],
      groupsToUpdate: [{ id: GROUP_UPDATED, name: "Renamed" }],
      groupsToDelete: [{ id: GROUP_DELETED }],
    });

    expect(await group(GROUP_CREATED)).toMatchObject({ name: "Created", eventTypeId: 1 });
    expect(String((await group(GROUP_CREATED))?.updatedAt)).toMatch(/\+00:00$/);
    expect(await group(GROUP_UPDATED)).toMatchObject({ name: "Renamed", eventTypeId: 1 });
    expect((await group(GROUP_UPDATED))?.updatedAt).not.toBe(SEEDED_AT);
    expect(await group(GROUP_DELETED)).toBeNull();
    expect(await group(GROUP_KEPT)).toMatchObject({ name: "Kept", updatedAt: SEEDED_AT });
    expect(await groupCount()).toBe(3);
  });

  it("nulls the deleted group's host assignment inside the same batch", async () => {
    await write({ groupsToDelete: [{ id: GROUP_DELETED }] });

    expect(await hostGroupId(1, 1)).toEqual({ groupId: GROUP_UPDATED });
    expect(await hostGroupId(2, 1)).toEqual({ groupId: null });
    expect(await hostGroupId(3, 2)).toEqual({ groupId: null });
  });

  it("rolls back every group change when a later statement fails", async () => {
    await db
      .prepare(
        `CREATE TRIGGER "fail_group_delete" BEFORE DELETE ON "HostGroup"
        BEGIN SELECT RAISE(ABORT, 'forced group delete failure'); END`
      )
      .run();

    await expect(
      write({
        groupsToCreate: [{ id: GROUP_CREATED, name: "Created" }],
        groupsToUpdate: [{ id: GROUP_UPDATED, name: "Renamed" }],
        groupsToDelete: [{ id: GROUP_DELETED }],
      })
    ).rejects.toThrow("forced group delete failure");

    await db.prepare('DROP TRIGGER "fail_group_delete"').run();
    expect(await group(GROUP_CREATED)).toBeNull();
    expect(await group(GROUP_UPDATED)).toMatchObject({ name: "Updated", updatedAt: SEEDED_AT });
    expect(await group(GROUP_DELETED)).toMatchObject({ name: "Deleted", updatedAt: SEEDED_AT });
    expect(await hostGroupId(2, 1)).toEqual({ groupId: GROUP_DELETED });
  });

  it("maps a missing group update to P2025 and rolls back the create", async () => {
    await expect(
      write({
        groupsToCreate: [{ id: GROUP_CREATED, name: "Created" }],
        groupsToUpdate: [{ id: GROUP_MISSING, name: "Missing" }],
      })
    ).rejects.toMatchObject({
      code: "P2025",
      meta: { modelName: "HostGroup", operation: "an update" },
    });

    expect(await group(GROUP_CREATED)).toBeNull();
    expect(await group(GROUP_UPDATED)).toMatchObject({ name: "Updated" });
  });

  it("maps constraint failures to the original Prisma codes", async () => {
    await expect(write({ groupsToCreate: [{ id: GROUP_KEPT, name: "Duplicate" }] })).rejects.toMatchObject({
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["id"] } },
        },
      },
    });
    expect(await group(GROUP_KEPT)).toMatchObject({ name: "Kept" });

    await expect(
      write({ eventTypeId: 999, groupsToCreate: [{ id: GROUP_CREATED, name: "Missing event" }] })
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await group(GROUP_CREATED)).toBeNull();

    await expect(
      write({ groupsToCreate: [{ id: GROUP_CREATED, name: null as unknown as string }] })
    ).rejects.toMatchObject({
      code: "P2011",
      meta: {
        driverAdapterError: {
          cause: { kind: "NullConstraintViolation", constraint: { fields: ["name"] } },
        },
      },
    });
    expect(await groupCount()).toBe(3);
  });

  it("keeps concurrent batches atomic", async () => {
    const results = await Promise.allSettled([
      write({
        groupsToCreate: [{ id: GROUP_CREATED, name: "Created" }],
        groupsToDelete: [{ id: GROUP_DELETED }],
      }),
      write({
        groupsToCreate: [{ id: GROUP_OTHER_CREATED, name: "Other" }],
        groupsToUpdate: [{ id: GROUP_UPDATED, name: "Renamed" }],
      }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await group(GROUP_CREATED)).toMatchObject({ name: "Created" });
    expect(await group(GROUP_OTHER_CREATED)).toMatchObject({ name: "Other" });
    expect(await group(GROUP_UPDATED)).toMatchObject({ name: "Renamed" });
    expect(await group(GROUP_DELETED)).toBeNull();
    expect(await hostGroupId(2, 1)).toEqual({ groupId: null });
    expect(await groupCount()).toBe(4);
  });

  it("does nothing when the handler has no group changes", async () => {
    await write({});

    expect(await groupCount()).toBe(3);
    expect(await group(GROUP_UPDATED)).toMatchObject({ name: "Updated", updatedAt: SEEDED_AT });
  });
});
