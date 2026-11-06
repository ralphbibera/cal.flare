import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { TrpcSessionUser } from "../../../types";
import { getTeamsForFeatureHandler } from "./getTeamsForFeature.handler";

describe("getTeamsForFeature search", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-teams-for-feature-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../../apps/web/cloudflare.config")).default;
    runtime = new Miniflare({
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
    db = await runtime.getD1Database("DB");
    const teams: Array<[id: number, name: string, slug: string | null, isPlatform?: number]> = [
      [1, "İlker Team", "first"],
      [2, "ascii", "ILKER-slug"],
      [3, "ılgaz", "dotless"],
      [4, "Σofia", null],
      [5, "100%_real", "wild"],
      [6, "ilker platform", "platform", 1],
      [7, "Late ılker", "late"],
      [8, "Ilker dup", "dup-a"],
      [9, "Ilker dup", "dup-b"],
      // More teams than one candidate batch, so a prefilter that keeps every team still scans to the end.
      ...Array.from({ length: 520 }, (_, index): [number, string, string] => [
        100 + index,
        `Filler ${index}`,
        `filler-${index}`,
      ]),
    ];
    const inserts = teams.map(([id, name, slug, isPlatform = 0]) =>
      db
        .prepare('INSERT INTO "Team" ("id", "name", "slug", "isPlatform") VALUES (?, ?, ?, ?)')
        .bind(id, name, slug, isPlatform)
    );
    for (let index = 0; index < inserts.length; index += 50) await db.batch(inserts.slice(index, index + 50));
    await db.batch([
      db.prepare(`INSERT INTO "Feature" ("slug", "enabled", "type") VALUES ('flag', 0, 'OPERATIONAL')`),
      db
        .prepare(
          `INSERT INTO "TeamFeatures" ("teamId", "featureId", "enabled", "assignedBy", "updatedAt") VALUES (2, 'flag', 1, 'admin', ?)`
        )
        .bind("2026-11-06T00:00:00.000+00:00"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const list = (input: { searchTerm?: string; cursor?: number; limit?: number }) =>
    withD1Database({ DB: db }, () =>
      getTeamsForFeatureHandler({
        ctx: { prisma, user: mockDeep<NonNullable<TrpcSessionUser>>() },
        input: { featureId: "flag", limit: 10, ...input },
      })
    );
  const ids = (result: Awaited<ReturnType<typeof list>>) => result.teams.map(({ id }) => id);

  it("folds Unicode across names and slugs, excluding platform teams", async () => {
    const result = await list({ searchTerm: "İLKER" });
    expect(ids(result)).toEqual([8, 9, 2, 1]);
    expect(result.teams.find(({ id }) => id === 2)).toMatchObject({ hasFeature: true, slug: "ILKER-slug" });
    expect(result.nextCursor).toBeUndefined();
    expect(ids(await list({ searchTerm: "platform" }))).toEqual([]);
  });

  it("confirms candidates the SQL prefilter keeps, scanning past a full batch", async () => {
    expect(ids(await list({ searchTerm: "ı" }))).toEqual([7, 3]);
    expect(ids(await list({ searchTerm: "σOFIA" }))).toEqual([4]);
  });

  it("keeps wildcard characters in a search as pattern syntax", async () => {
    expect(ids(await list({ searchTerm: "1%_R" }))).toEqual([5]);
  });

  it("pages as the cursor read did, skipping the first match at or after the cursor", async () => {
    const first = await list({ searchTerm: "ilker", limit: 2 });
    expect(ids(first)).toEqual([8, 9]);
    expect(first.nextCursor).toBe(2);
    expect(ids(await list({ searchTerm: "ilker", limit: 2, cursor: 2 }))).toEqual([1]);
    expect(ids(await list({ searchTerm: "ilker", cursor: 7 }))).toEqual([1]);
    expect(ids(await list({ searchTerm: "ilker", cursor: 9999 }))).toEqual([]);
  });

  it("keeps unsearched pages unchanged", async () => {
    const result = await list({ limit: 2 });
    expect(ids(result)).toEqual([5, 100]);
    expect(result.nextCursor).toBe(101);
  });
});
