import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WrongAssignmentReportRepository } from "./WrongAssignmentReportRepository";

const TEAM_COUNT = 250;

describe("WrongAssignmentReportRepository over a long team list on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const teamIds = Array.from({ length: TEAM_COUNT }, (_, index) => index + 1);
  const repository = new WrongAssignmentReportRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-wrong-assignment-large-lists-"));
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
      ...teamIds.map((id) =>
        db.prepare('INSERT INTO "Team" ("id", "name") VALUES (?, ?)').bind(id, `Team ${id}`)
      ),
      ...teamIds.map((id) =>
        db
          .prepare(
            `INSERT INTO "Booking" ("uid", "title", "startTime", "endTime")
             VALUES (?, ?, '2026-01-01T00:00:00.000+00:00', '2026-01-01T00:30:00.000+00:00')`
          )
          .bind(`booking-${id}`, `Booking ${id}`)
      ),
      ...teamIds.map((id) =>
        db
          .prepare(
            `INSERT INTO "WrongAssignmentReport" ("id", "bookingUid", "additionalNotes", "teamId", "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            `report-${id}`,
            `booking-${id}`,
            `Notes ${id}`,
            id,
            new Date(Date.UTC(2026, 0, 1, 0, 0, id - 1)).toISOString().replace("Z", "+00:00"),
            "2026-01-01T00:00:00.000+00:00"
          )
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("keeps the offset page and total for a long team list", async () => {
    const { reports, totalCount } = await inD1(() =>
      repository.findByTeamIdsAndStatuses({ teamIds, statuses: ["PENDING"], limit: 10, offset: 5 })
    );
    expect(totalCount).toBe(TEAM_COUNT);
    expect(reports.map(({ id }) => id)).toEqual([
      "report-245",
      "report-244",
      "report-243",
      "report-242",
      "report-241",
      "report-240",
      "report-239",
      "report-238",
      "report-237",
      "report-236",
    ]);
  });
});
