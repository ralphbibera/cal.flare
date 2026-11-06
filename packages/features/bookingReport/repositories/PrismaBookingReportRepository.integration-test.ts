import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaBookingReportRepository } from "./PrismaBookingReportRepository";

const timestamp = (minute: number) => `2026-11-05T00:${String(minute).padStart(2, "0")}:00.000+00:00`;
const UNTOUCHED = "2000-01-01T00:00:00.000+00:00";

describe("booking report email matching", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-booking-report-"));
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
      db.prepare(`INSERT INTO "Team" ("id", "name") VALUES (1, 'One'), (2, 'Two'), (3, 'Three')`),
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1, 'r1', 'İnceleme@corp.invalid'), (2, 'r2', 'plain@corp.invalid')`
      ),
      db.prepare(`INSERT INTO "Watchlist" ("id", "type", "value") VALUES ('linked', 'EMAIL', 'x')`),
    ]);
    const rows: [string, string, number, number | null, number, string?, string?][] = [
      ["dotted", "İlker@spam.invalid", 1, 2, 1],
      ["ascii", "ILKER@spam.invalid", 1, 2, 2],
      ["ascii-2", "ILKER@spam.invalid", 1, 2, 3],
      ["dotless", "ılgaz@spam.invalid", 1, 2, 4],
      ["sigma", "Σofia@spam.invalid", 1, null, 5],
      ["reporter", "shared@spam.invalid", 1, 1, 6],
      ["reporter-2", "shared@spam.invalid", 1, 2, 7],
      ["wild", "100%_real@spam.invalid", 1, 2, 8],
      ["other-org", "ilker@spam.invalid", 2, 2, 9],
      ["blocked", "ilker@spam.invalid", 1, 2, 10, "BLOCKED"],
      ["linked", "ilker@spam.invalid", 1, 2, 11, "PENDING", "linked"],
      ["suffix", "ilker@spam.invalid.example", 1, 2, 12],
      ...Array.from({ length: 110 }, (_, index): [string, string, number, null, number] => [
        `same-${index}`,
        "Same@BÜLK.invalid",
        3,
        null,
        index % 60,
      ]),
    ];
    for (let index = 0; index < rows.length; index += 25) {
      await db.batch(
        rows.slice(index, index + 25).flatMap(([id, email, org, reporter, minute, status, watchlist]) => [
          db
            .prepare(
              'INSERT INTO "Booking" ("uid", "title", "description", "startTime", "endTime", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)'
            )
            .bind(id, id, "", timestamp(0), timestamp(1), timestamp(0)),
          db
            .prepare(
              `INSERT INTO "BookingReport" ("id", "bookingUid", "bookerEmail", "reportedById", "organizationId", "reason", "createdAt", "updatedAt", "status", "systemStatus", "watchlistId", "globalWatchlistId")
               VALUES (?, ?, ?, ?, ?, 'SPAM', ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              id,
              id,
              email,
              reporter,
              org,
              timestamp(minute),
              UNTOUCHED,
              status ?? "PENDING",
              status ?? "PENDING",
              watchlist ?? null,
              watchlist ?? null
            ),
        ])
      );
    }
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const repository = new PrismaBookingReportRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  const list = (searchTerm: string, organizationId = 1, skip?: number, take?: number) =>
    inD1(() => repository.findAllReportedBookings({ organizationId, searchTerm, skip, take }));
  const grouped = (searchTerm: string, organizationId = 1, skip?: number, take?: number) =>
    inD1(() => repository.findGroupedReportedBookings({ organizationId, searchTerm, skip, take }));

  it("folds Unicode across booker and reporter emails, newest first", async () => {
    const dotted = await list("İLKER");
    expect(ids(dotted.rows)).toEqual(["suffix", "linked", "blocked", "ascii-2", "ascii", "dotted"]);
    expect(dotted.meta.totalRowCount).toBe(6);
    expect(ids((await list("ı")).rows)).toEqual(["dotless"]);
    expect(ids((await list("σofia")).rows)).toEqual(["sigma"]);
    expect(ids((await list("inceleme@")).rows)).toEqual(["reporter"]);
    expect(ids((await list("1%_R")).rows)).toEqual(["wild"]);
    expect(ids((await list("ilker", 2)).rows)).toEqual(["other-org"]);
  });

  it("matches before paging and keeps the unsearched selection", async () => {
    const page = await list("ilker", 1, 1, 2);
    expect(ids(page.rows)).toEqual(["linked", "blocked"]);
    expect(page.meta.totalRowCount).toBe(6);
    expect((await list("spam.invalid.example")).rows).toEqual(
      (await inD1(() => repository.findAllReportedBookings({ organizationId: 1, take: 1 }))).rows
    );
    expect((await list("bÜlk", 3, 100, 100)).rows).toHaveLength(10);
  });

  it("groups by exact email, latest first, keeping only matched reports", async () => {
    const result = await grouped("İLKER");
    expect(result.meta.totalRowCount).toBe(4);
    expect(result.rows.map((row) => [row.bookerEmail, row.reportCount, ids(row.reports)])).toEqual([
      ["ilker@spam.invalid.example", 1, ["suffix"]],
      ["ilker@spam.invalid", 2, ["blocked", "linked"]],
      ["ILKER@spam.invalid", 2, ["ascii", "ascii-2"]],
      ["İlker@spam.invalid", 1, ["dotted"]],
    ]);
    expect((await grouped("inceleme")).rows.map((row) => ids(row.reports))).toEqual([["reporter"]]);
    expect((await grouped("ilker", 2)).rows.flatMap((row) => ids(row.reports))).toEqual(["other-org"]);
    expect(await grouped("ilker", 1, 9)).toEqual({ rows: [], meta: { totalRowCount: 4 } });
  });

  it("orders groups by report count and pages after matching", async () => {
    const byCount = await inD1(() =>
      repository.findGroupedReportedBookings({
        organizationId: 1,
        searchTerm: "ilker",
        sortBy: "reportCount",
        take: 3,
      })
    );
    expect(byCount.rows.map((row) => row.reportCount)).toEqual([2, 2, 1]);
    expect(byCount.meta.totalRowCount).toBe(4);
  });

  it("keeps equals and endsWith guarded, anchored and ILIKE-shaped", async () => {
    const byEmail = (email: string, organizationId = 1) =>
      inD1(() => repository.findPendingReportsByEmail({ email, organizationId }));
    const expected = ["ascii", "ascii-2", "dotted"];
    expect(ids(await byEmail("ilker@spam.invalid")).toSorted()).toEqual(expected);
    expect(ids(await byEmail("ilke__spam.invalid")).toSorted()).toEqual(expected);
    await expect(byEmail("ilker\\")).rejects.toThrow("must not end with escape character");

    const byDomain = await inD1(() =>
      repository.findPendingReportsByDomain({ domain: "SPAM.INVALID", organizationId: 2 })
    );
    expect(byDomain).toEqual([{ id: "other-org", bookerEmail: "ilker@spam.invalid", watchlistId: null }]);

    const system = await inD1(() => repository.findPendingSystemReportsByDomain({ domain: "spam.invalid" }));
    expect(ids(system)).toContain("other-org");
    for (const id of ["blocked", "linked", "suffix"]) expect(ids(system)).not.toContain(id);
    const systemEmail = await inD1(() =>
      repository.findPendingSystemReportsByEmail({ email: "ILKER@SPAM.INVALID" })
    );
    expect(ids(systemEmail).toSorted()).toEqual([...expected, "other-org"].toSorted());
  });

  // Runs last: dismissals change the rows the reads above rely on.
  it("dismisses only matched guarded reports, atomically past D1's bind limit", async () => {
    const row = (id: string) =>
      db
        .prepare('SELECT "status", "systemStatus", "updatedAt" FROM "BookingReport" WHERE "id" = ?')
        .bind(id)
        .first<{ status: string; systemStatus: string; updatedAt: string }>();
    const dismiss = (email: string, organizationId: number) =>
      inD1(() => repository.dismissReportsByEmail({ email, status: "DISMISSED", organizationId }));

    expect(await dismiss("ilker@spam.invalid", 1)).toEqual({ count: 3 });
    expect(await dismiss("ilker@spam.invalid", 1)).toEqual({ count: 0 });
    expect(await dismiss("same@bülk.invalid", 3)).toEqual({ count: 110 });
    const dismissed = await row("dotted");
    expect(dismissed).toMatchObject({ status: "DISMISSED", systemStatus: "PENDING" });
    expect(dismissed?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+\+00:00$/);
    expect(dismissed?.updatedAt).not.toBe(UNTOUCHED);
    for (const [id, status] of [
      ["other-org", "PENDING"],
      ["blocked", "BLOCKED"],
      ["linked", "PENDING"],
      ["suffix", "PENDING"],
    ]) {
      expect(await row(id)).toMatchObject({ status, updatedAt: UNTOUCHED });
    }

    const system = await inD1(() =>
      repository.dismissSystemReportsByEmail({ email: "İLKER@spam.invalid", systemStatus: "DISMISSED" })
    );
    expect(system).toEqual({ count: 4 });
    expect(await row("other-org")).toMatchObject({ status: "PENDING", systemStatus: "DISMISSED" });
    expect(await row("linked")).toMatchObject({ systemStatus: "PENDING", updatedAt: UNTOUCHED });
  });
});
