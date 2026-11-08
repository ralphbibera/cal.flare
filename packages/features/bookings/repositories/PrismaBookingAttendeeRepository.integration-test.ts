import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it as vitestIt } from "vitest";
import { PrismaBookingAttendeeRepository } from "./PrismaBookingAttendeeRepository";

describe("PrismaBookingAttendeeRepository on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  const inD1 = <T>(callback: () => T): T => withD1Database({ DB: db }, callback);
  const it = (name: string, callback: () => unknown): void => vitestIt(name, () => inD1(callback));
  const repository = (): PrismaBookingAttendeeRepository => new PrismaBookingAttendeeRepository(prisma);

  const initialResponses = {
    name: "Primary",
    email: "primary@example.com",
    guests: ["secondary@example.com", "third@example.com"],
    location: { value: "attendee-address", optionValue: "" },
  };
  const deletedResponses = {
    name: "Primary",
    email: "primary@example.com",
    guests: ["third@example.com"],
    location: { value: "attendee-address", optionValue: "" },
    "custom field": { answers: [1, 2] },
  };

  const attendeeIds = async (): Promise<number[]> =>
    (
      await db
        .prepare(`SELECT "id" FROM "Attendee" WHERE "bookingId" = 1 ORDER BY "id"`)
        .all<{ id: number }>()
    ).results.map((row) => row.id);
  const booking = async (): Promise<{ responses: string; updatedAt: string } | null> =>
    await db
      .prepare(`SELECT "responses", "updatedAt" FROM "Booking" WHERE "id" = 1`)
      .first<{ responses: string; updatedAt: string }>();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-attendee-delete-"));
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
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare(`DROP TRIGGER IF EXISTS "fail_attendee_delete_rewrite"`),
      db.prepare(`DELETE FROM "BookingSeat"`),
      db.prepare(`DELETE FROM "Attendee"`),
      db.prepare(`DELETE FROM "Booking"`),
      db
        .prepare(
          `INSERT INTO "Booking" ("id", "uid", "title", "responses", "startTime", "endTime", "updatedAt")
           VALUES (1, 'attendee-delete', 'Attendee delete', ?, '2030-06-01T10:00:00.000+00:00', '2030-06-01T10:30:00.000+00:00', '2029-01-01T00:00:00.000+00:00')`
        )
        .bind(JSON.stringify(initialResponses)),
      db.prepare(
        `INSERT INTO "Attendee" ("id", "email", "name", "timeZone", "bookingId") VALUES
         (1, 'primary@example.com', 'Primary', 'UTC', 1),
         (2, 'secondary@example.com', 'Secondary', 'UTC', 1),
         (3, 'third@example.com', 'Third', 'UTC', 1)`
      ),
      db.prepare(
        `INSERT INTO "BookingSeat" ("referenceUid", "bookingId", "attendeeId") VALUES ('seat-secondary', 1, 2)`
      ),
    ]);
  });

  it("deletes the attendee and rewrites the booking responses in one commit", async () => {
    const startedAt = Date.now();

    await repository().deleteByIdAndUpdateBookingResponses(2, 1, deletedResponses);

    expect(await attendeeIds()).toEqual([1, 3]);
    const updated = await booking();
    expect(updated?.responses).toBe(JSON.stringify(deletedResponses));
    expect(JSON.parse(updated?.responses ?? "null")).toEqual(deletedResponses);
    expect(new Date(updated?.updatedAt ?? 0).getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(new Date(updated?.updatedAt ?? 0).getTime()).toBeLessThanOrEqual(Date.now());
    expect(
      await db.prepare(`SELECT COUNT(*) FROM "BookingSeat" WHERE "attendeeId" = 2`).first("COUNT(*)")
    ).toBe(0);
  });

  it("reports P2025 for a missing attendee and leaves the responses untouched", async () => {
    await expect(
      repository().deleteByIdAndUpdateBookingResponses(999, 1, deletedResponses)
    ).rejects.toMatchObject({ code: "P2025", meta: { modelName: "Attendee", operation: "a delete" } });

    expect(await attendeeIds()).toEqual([1, 2, 3]);
    expect((await booking())?.responses).toBe(JSON.stringify(initialResponses));
  });

  it("reports P2025 for a missing booking and rolls the attendee delete back", async () => {
    await expect(
      repository().deleteByIdAndUpdateBookingResponses(2, 999, deletedResponses)
    ).rejects.toMatchObject({ code: "P2025", meta: { modelName: "Booking", operation: "an update" } });

    expect(await attendeeIds()).toEqual([1, 2, 3]);
    expect((await booking())?.responses).toBe(JSON.stringify(initialResponses));
  });

  it("rolls the delete back when the later responses update fails", async () => {
    await db
      .prepare(
        `CREATE TRIGGER "fail_attendee_delete_rewrite" BEFORE UPDATE ON "Booking"
         WHEN OLD."id" = 1 BEGIN SELECT RAISE(ABORT, 'synthetic attendee rewrite failure'); END`
      )
      .run();

    await expect(repository().deleteByIdAndUpdateBookingResponses(2, 1, deletedResponses)).rejects.toThrow(
      "synthetic attendee rewrite failure"
    );
    await db.prepare(`DROP TRIGGER "fail_attendee_delete_rewrite"`).run();

    expect(await attendeeIds()).toEqual([1, 2, 3]);
    expect((await booking())?.responses).toBe(JSON.stringify(initialResponses));
    expect(
      await db.prepare(`SELECT COUNT(*) FROM "BookingSeat" WHERE "attendeeId" = 2`).first("COUNT(*)")
    ).toBe(1);
  });

  it("lets only one of two simultaneous deletes of the same attendee commit", async () => {
    const otherResponses = { ...deletedResponses, guests: ["secondary@example.com"] };
    const results = await Promise.allSettled([
      repository().deleteByIdAndUpdateBookingResponses(2, 1, deletedResponses),
      repository().deleteByIdAndUpdateBookingResponses(2, 1, otherResponses),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "P2025", meta: { modelName: "Attendee", operation: "a delete" } },
    });
    expect(await attendeeIds()).toEqual([1, 3]);
    expect([JSON.stringify(deletedResponses), JSON.stringify(otherResponses)]).toContain(
      (await booking())?.responses
    );
  });
});
