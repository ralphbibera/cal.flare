import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRepository } from "@calcom/features/host/repositories/HostRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MembershipRepository } from "./MembershipRepository";

const COUNT = 250;

describe("reads over long id lists on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ids = Array.from({ length: COUNT }, (_, index) => index + 1);
  const membership = new MembershipRepository(prisma);
  const hosts = new HostRepository(prisma);
  const users = new UserRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-large-lists-"));
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
    await db.batch([
      ...ids.map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
          .bind(id, `large-list-${id}`, `large-list-${id}@example.invalid`)
      ),
      ...ids.map((id) =>
        db.prepare('INSERT INTO "Team" ("id", "name") VALUES (?, ?)').bind(id, `Team ${id}`)
      ),
      ...ids.map((id) =>
        db
          .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, ?, 1, ?)')
          .bind(id, id, "MEMBER")
      ),
      ...ids
        .slice(1)
        .map((id) =>
          db
            .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (1, ?, 1, ?)')
            .bind(id, "MEMBER")
        ),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length") VALUES (1, 'Large list', 'large-list', 30)`
      ),
      ...ids.map((id) => db.prepare('INSERT INTO "Host" ("eventTypeId", "userId") VALUES (1, ?)').bind(id)),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("lists accepted memberships for every requested team", async () => {
    const rows = await inD1(() =>
      MembershipRepository.findAllByTeamIds({ teamIds: ids, select: { teamId: true } })
    );
    expect(rows).toHaveLength(COUNT * 2 - 1);
    expect(new Set(rows.map(({ teamId }) => teamId)).size).toBe(COUNT);
  });

  it("lists accepted memberships for every requested user in a team", async () => {
    const rows = await inD1(() =>
      MembershipRepository.findAcceptedMembershipsByUserIdsInTeam({ userIds: ids, teamId: 1 })
    );
    expect(rows.map(({ userId }) => userId).sort((a, b) => a - b)).toEqual(ids);
  });

  it("pages team members inside a long member selection", async () => {
    const first = await inD1(() => membership.searchMembers({ teamId: 1, limit: 10, memberUserIds: ids }));
    expect(first.memberships.map(({ user }) => user.id)).toEqual(ids.slice(0, 10));
    expect(first).toMatchObject({ hasMore: true, nextCursor: 10 });

    const second = await inD1(() =>
      membership.searchMembers({ teamId: 1, limit: 10, memberUserIds: ids, cursor: first.nextCursor })
    );
    expect(second.memberships.map(({ user }) => user.id)).toEqual(ids.slice(10, 20));
  });

  it("pages assignment hosts inside a long member selection", async () => {
    const first = await inD1(() =>
      hosts.findHostsPaginatedIncludeUserForAssignment({ eventTypeId: 1, limit: 10, memberUserIds: ids })
    );
    expect(first.items.map(({ userId }) => userId)).toEqual(ids.slice(0, 10));
    expect(first).toMatchObject({ hasMore: true, nextCursor: 10 });

    const second = await inD1(() =>
      hosts.findHostsPaginatedIncludeUserForAssignment({
        eventTypeId: 1,
        limit: 10,
        memberUserIds: ids,
        cursor: first.nextCursor,
      })
    );
    expect(second.items.map(({ userId }) => userId)).toEqual(ids.slice(10, 20));
  });

  it("finds every user by a long id list", async () => {
    const rows = await inD1(() => users.findByIds({ ids }));
    expect(rows.map(({ id }) => id).sort((a, b) => a - b)).toEqual(ids);
  });

  it("finds every user by a long uuid list", async () => {
    const rows = await inD1(() => users.findByUuids({ uuids: ids.map((id) => `large-list-${id}`) }));
    expect(rows.map(({ id }) => id).sort((a, b) => a - b)).toEqual(ids);
  });
});
