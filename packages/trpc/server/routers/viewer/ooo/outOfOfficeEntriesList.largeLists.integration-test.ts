import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outOfOfficeEntriesList } from "./outOfOfficeEntriesList.handler";

const MEMBER_COUNT = 250;

describe("outOfOfficeEntriesList over a long team member list on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const entryIds = Array.from({ length: MEMBER_COUNT }, (_, index) => index + 1);
  const listed = (result: { rows: Array<{ id: number }> }) => result.rows.map(({ id }) => id);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const context = (input: Parameters<typeof outOfOfficeEntriesList>[0]["input"]) => ({
    ctx: { user: { id: 1, locale: "en" } as unknown as NonNullable<TrpcSessionUser> },
    input,
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-ooo-large-lists-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../../apps/web/cloudflare.config")).default;
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
    const updatedAt = "2026-01-01T00:00:00.000+00:00";
    await db.batch([
      db
        .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (1, ?, ?)')
        .bind("ooo-owner", "owner@example.invalid"),
      db.prepare('INSERT INTO "Team" ("id", "name") VALUES (1, ?)').bind("Team 1"),
      db
        .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (1, 1, 1, ?)')
        .bind("MEMBER"),
      ...entryIds.map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
          .bind(id + 1, `ooo-member-${id}`, `member${id}@example.invalid`)
      ),
      ...entryIds.map((id) =>
        db
          .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (1, ?, 1, ?)')
          .bind(id + 1, "MEMBER")
      ),
      ...entryIds.map((id) =>
        db
          .prepare(
            'INSERT INTO "OutOfOfficeEntry" ("uuid", "start", "end", "userId", "updatedAt") VALUES (?, ?, ?, ?, ?)'
          )
          .bind(
            `ooo-${id}`,
            new Date(Date.UTC(2027, 0, 1, 0, 0, id)).toISOString().replace("Z", "+00:00"),
            "2027-02-01T00:00:00.000+00:00",
            id + 1,
            updatedAt
          )
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("pages every team member's entries without changing totals", async () => {
    const first = await inD1(() =>
      outOfOfficeEntriesList(
        context({
          limit: 10,
          fetchTeamMembersEntries: true,
          endDateFilterStartRange: "2026-01-01T00:00:00.000Z",
        })
      )
    );
    expect(listed(first)).toEqual(entryIds.slice(0, 10));
    expect(first).toMatchObject({ nextCursor: 11, meta: { totalRowCount: MEMBER_COUNT } });

    const second = await inD1(() =>
      outOfOfficeEntriesList(
        context({
          limit: 10,
          cursor: first.nextCursor,
          fetchTeamMembersEntries: true,
          endDateFilterStartRange: "2026-01-01T00:00:00.000Z",
        })
      )
    );
    expect(listed(second)).toEqual(entryIds.slice(11, 21));
    expect(second).toMatchObject({ nextCursor: 22, meta: { totalRowCount: MEMBER_COUNT } });
  });
});
