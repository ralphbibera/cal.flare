import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaCredentialRepository } from "./PrismaCredentialRepository";

describe("category-scoped credentials", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-calendar-credentials-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../apps/web/cloudflare.config")).default;
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
    await db.batch([
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1, 'category-user-1', 'owner@example.invalid'), (2, 'category-user-2', 'other@example.invalid'), (99, 'category-user-99', 'delegated@example.invalid')`
      ),
      db.prepare(
        `INSERT INTO "Team" ("id", "name", "slug") VALUES (1, 'Team', 'team'), (2, '', 'org'), (3, 'Other', 'other')`
      ),
      ...[
        ["both", '["calendar","video","video"]', 1],
        ["disabled", '["calendar","video"]', 0],
        ["empty", "[]", 1],
        ["absent", null, 1],
      ].map(([slug, categories, enabled]) =>
        db
          .prepare(
            'INSERT INTO "App" ("slug", "dirName", "categories", "enabled", "updatedAt") VALUES (?, ?, ?, ?, ?)'
          )
          .bind(slug, slug, categories, enabled, "2026-11-05T00:00:00.000+00:00")
      ),
      ...[
        [1, "both", 1, null, 1],
        [2, "disabled", 1, null, null],
        [3, "both", 2, 1, 0],
        [4, "both", null, 2, 0],
        [5, "both", null, 3, 0],
        [6, "empty", 1, null, 0],
        [7, "absent", 1, null, 0],
        [8, null, 1, null, 0],
      ].map(([id, appId, userId, teamId, invalid]) =>
        db
          .prepare(
            'INSERT INTO "Credential" ("id", "type", "key", "encryptedKey", "appId", "userId", "teamId", "invalid") VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            id,
            "calendar",
            JSON.stringify({ token: `synthetic-${id}` }),
            "encrypted",
            appId,
            userId,
            teamId,
            invalid
          )
      ),
      db.prepare(
        `INSERT INTO "SelectedCalendar" ("id", "userId", "integration", "externalId", "credentialId") VALUES ('selected-1', 1, 'calendar', 'external', 1)`
      ),
      db
        .prepare(
          `INSERT INTO "WorkspacePlatform" ("id", "slug", "name", "description", "defaultServiceAccountKey", "updatedAt") VALUES (99, 'test', 'Test', '', '{}', ?)`
        )
        .bind("2026-11-05T00:00:00.000+00:00"),
      db
        .prepare(
          `INSERT INTO "DelegationCredential" ("id", "workspacePlatformId", "serviceAccountKey", "organizationId", "domain", "updatedAt") VALUES ('delegation', 99, '{}', 2, 'example.invalid', ?)`
        )
        .bind("2026-11-05T00:00:00.000+00:00"),
      db.prepare(
        `INSERT INTO "Credential" ("id", "type", "key", "appId", "userId", "delegationCredentialId") VALUES (99, 'calendar', '{}', 'both', 99, 'delegation')`
      ),
    ]);
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const repository = new PrismaCredentialRepository();
  it("retains own matching credentials including disabled apps and nullable invalid state", async () => {
    const credentials = await withD1Database({ DB: db }, () =>
      repository.findNonDelegationCredentialsByAppCategories({
        owner: { userId: 1 },
        appCategories: ["video", "conferencing", "video"],
      })
    );
    expect(credentials.map(({ id }) => id).sort()).toEqual([1, 2]);
    expect(credentials.find(({ id }) => id === 1)).toEqual({
      id: 1,
      appId: "both",
      type: "calendar",
      userId: 1,
      user: { email: "owner@example.invalid" },
      teamId: null,
      team: null,
      key: { token: "synthetic-1" },
      encryptedKey: "encrypted",
      invalid: true,
      delegationCredentialId: null,
      delegatedTo: null,
      delegatedToId: null,
    });
    expect(credentials.find(({ id }) => id === 2)?.invalid).toBeNull();
  });

  it("retains team plus organization scope, empty team names and absent users", async () => {
    const credentials = await withD1Database({ DB: db }, () =>
      repository.findNonDelegationCredentialsByAppCategories({
        owner: { teamIds: [1, 2] },
        appCategories: ["video"],
      })
    );
    expect(credentials.map(({ id }) => id).sort()).toEqual([3, 4]);
    expect(credentials.find(({ id }) => id === 3)?.team).toEqual({ name: "Team" });
    expect(credentials.find(({ id }) => id === 4)).toMatchObject({ user: null, team: { name: "" } });
    expect(
      await withD1Database({ DB: db }, () =>
        repository.findNonDelegationCredentialsByAppCategories({
          owner: { teamIds: [] },
          appCategories: ["video"],
        })
      )
    ).toEqual([]);
    expect(
      await withD1Database({ DB: db }, () =>
        repository.findNonDelegationCredentialsByAppCategories({ owner: { userId: 1 }, appCategories: [] })
      )
    ).toEqual([]);
  });

  it("selects enabled calendar credentials and their selected calendar ids in the same read", async () => {
    expect(
      await withD1Database({ DB: db }, () => repository.findEnabledCalendarCredentialsForUser(1))
    ).toEqual([
      {
        id: 1,
        appId: "both",
        type: "calendar",
        userId: 1,
        user: { email: "owner@example.invalid" },
        teamId: null,
        key: { token: "synthetic-1" },
        encryptedKey: "encrypted",
        invalid: true,
        delegationCredentialId: null,
        selectedCalendars: [{ id: "selected-1" }],
      },
    ]);
    expect(
      await withD1Database({ DB: db }, () => repository.findEnabledCalendarCredentialsForUser(999))
    ).toEqual([]);
  });
  it("keeps source delegation selection and each caller's projection policy", async () => {
    const credentials = await withD1Database({ DB: db }, () =>
      repository.findNonDelegationCredentialsByAppCategories({
        owner: { userId: 99 },
        appCategories: ["video"],
      })
    );
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      id: 99,
      delegationCredentialId: null,
      delegatedTo: null,
      delegatedToId: null,
    });
    const calendars = await withD1Database({ DB: db }, () =>
      repository.findEnabledCalendarCredentialsForUser(99)
    );
    expect(calendars).toHaveLength(1);
    expect(calendars[0]).toMatchObject({
      id: 99,
      delegationCredentialId: "delegation",
      selectedCalendars: [],
    });
    expect(JSON.stringify(calendars)).not.toContain("serviceAccountKey");
  });
});
