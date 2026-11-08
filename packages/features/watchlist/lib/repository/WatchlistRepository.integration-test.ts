import { prisma } from "@calcom/prisma";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect } from "vitest";
import { WatchlistRepository } from "./WatchlistRepository";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../apps/web/cloudflare.config")).default.worker,
});

const timestamp = (minute: number) => `2026-11-05T00:${String(minute).padStart(2, "0")}:00.000+00:00`;

describe("watchlist entry search", () => {
  d1.beforeAll(async () => {
    const entry = (id: string, value: string, org: number | null, minute: number, type = "EMAIL") =>
      d1.db
        .prepare(
          'INSERT INTO "Watchlist" ("id", "type", "value", "organizationId", "isGlobal", "lastUpdatedAt") VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(id, type, value, org, org === null ? 1 : 0, timestamp(minute));
    await d1.db.batch([
      d1.db.prepare(`INSERT INTO "Team" ("id", "name") VALUES (1, 'One'), (2, 'Two'), (3, 'Three')`),
      entry("dotted", "İlker@example.invalid", null, 1),
      entry("ascii", "ILKER@example.invalid", null, 2),
      entry("dotless", "ılgaz@example.invalid", null, 3),
      entry("sigma", "Σofia@example.invalid", null, 4),
      entry("wild", "100%_real@example.invalid", null, 5),
      entry("domain", "ilker.invalid", null, 6, "DOMAIN"),
      entry("org-one", "ilker-org@example.invalid", 1, 7),
      entry("org-two", "ilker-other@example.invalid", 2, 8),
      d1.db
        .prepare(
          `INSERT INTO "WatchlistAudit" ("id", "watchlistId", "type", "value", "changedAt", "changedByUserId")
           VALUES ('old', 'org-one', 'EMAIL', 'x', ?, 41), ('new', 'org-one', 'EMAIL', 'x', ?, 42)`
        )
        .bind(timestamp(1), timestamp(2)),
    ]);
    const bulk = Array.from({ length: 120 }, (_, index) =>
      entry(`bulk-${String(index).padStart(3, "0")}`, `büLK${index}@example.invalid`, 3, index % 60)
    );
    for (let index = 0; index < bulk.length; index += 50) await d1.db.batch(bulk.slice(index, index + 50));
  }, 30_000);

  const repository = new WatchlistRepository(prisma);
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  const listGlobal = (searchTerm?: string, limit = 25, offset = 0) =>
    d1.run(() =>
      repository.findAllEntriesWithLatestAudit({
        organizationId: null,
        isGlobal: true,
        limit,
        offset,
        searchTerm,
      })
    );
  const listOrg = (organizationId: number, searchTerm?: string, limit = 25, offset = 0) =>
    d1.run(() => repository.findOrgAndGlobalEntries({ organizationId, limit, offset, searchTerm }));

  d1.it("folds Unicode as PostgreSQL did, newest first, within the global scope", async () => {
    const dotted = await listGlobal("İLKER");
    expect(ids(dotted.rows)).toEqual(["domain", "ascii", "dotted"]);
    expect(dotted.meta.totalRowCount).toBe(3);
    expect(ids((await listGlobal("ı")).rows)).toEqual(["dotless"]);
    expect(ids((await listGlobal("σOFIA")).rows)).toEqual(["sigma"]);
  });

  d1.it("keeps wildcard characters in a search as pattern syntax", async () => {
    expect(ids((await listGlobal("1%_R")).rows)).toEqual(["wild"]);
    expect(ids((await listGlobal("100\\%")).rows)).toEqual(["wild"]);
    expect((await listGlobal("%")).meta.totalRowCount).toBe(6);
  });

  d1.it("matches before paging, counts every match and keeps the unsearched selection", async () => {
    const last = await listGlobal("ilker", 2, 2);
    expect(ids(last.rows)).toEqual(["dotted"]);
    expect(last.meta.totalRowCount).toBe(3);

    const filtered = await d1.run(() =>
      repository.findAllEntriesWithLatestAudit({
        organizationId: null,
        isGlobal: true,
        limit: 25,
        offset: 0,
        searchTerm: "ilker",
        filters: { type: "DOMAIN" },
      })
    );
    expect(ids(filtered.rows)).toEqual(["domain"]);
    expect(filtered.rows[0]).toEqual((await listGlobal(undefined, 1)).rows[0]);
  });

  d1.it("keeps another organization's entries out and flags global entries read-only", async () => {
    const result = await listOrg(1, "ILKER");
    expect(ids(result.rows)).toEqual(["org-one", "domain", "ascii", "dotted"]);
    expect(result.rows.map((row) => row.isReadOnly)).toEqual([false, true, true, true]);
    expect(result.rows[0].latestAudit).toEqual({ changedByUserId: 42 });
    expect(ids((await listOrg(2, "ilker-org")).rows)).toEqual([]);
  });

  d1.it("scans past one batch and returns a full page", async () => {
    const page = await listOrg(3, "BÜLK", 100, 0);
    expect(page.rows).toHaveLength(100);
    expect(page.meta.totalRowCount).toBe(120);
    const updatedAt = page.rows.map((row) => row.lastUpdatedAt?.getTime() ?? 0);
    expect(updatedAt).toEqual(updatedAt.toSorted((a, b) => b - a));
    expect((await listOrg(3, "BÜLK", 100, 100)).rows).toHaveLength(20);
  });
});
