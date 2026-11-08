import { runD1Batch } from "@calcom/prisma/d1-batch";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileD1Statement, requireD1RecordFor } from "./d1";
import kysely from "./index";

describe("typed D1 batch statements", () => {
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    mf = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "d1-typed-batch",
            compatibilityDate: "2026-11-04",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
              },
            },
            env: {
              DB: { type: "d1", name: "typed-batch", dev: { remote: false } },
            },
          },
        },
      ],
    });
    db = await mf.getD1Database("DB");
    await db
      .prepare(
        `CREATE TABLE "Attendee" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "email" TEXT NOT NULL,
          "name" TEXT NOT NULL,
          "timeZone" TEXT NOT NULL,
          "bookingId" INTEGER
        )`
      )
      .run();
  }, 60_000);

  afterAll(() => mf?.dispose());

  beforeEach(async () => {
    await db.batch([
      db.prepare('DELETE FROM "Attendee"'),
      db.prepare(
        `INSERT INTO "Attendee" ("id", "email", "name", "timeZone", "bookingId")
          VALUES (1, 'one@example.invalid', 'One', 'UTC', NULL),
            (2, 'two@example.invalid', 'Two', 'UTC', 4)`
      ),
    ]);
  });

  it("runs a compiled typed update inside a guarded batch", async () => {
    const update = compileD1Statement(
      db,
      kysely.updateTable("Attendee").set({ bookingId: 7 }).where("id", "=", 1)
    );
    expect(
      await db.prepare('SELECT "bookingId" FROM "Attendee" WHERE "id" = 1').first("bookingId")
    ).toBeNull();

    await runD1Batch(
      db,
      [
        requireD1RecordFor(
          db,
          { modelName: "Attendee", operation: "an update" },
          kysely.selectFrom("Attendee").select("id").where("id", "=", 1)
        ),
        update,
      ],
      { modelName: "Attendee" }
    );

    expect(await db.prepare('SELECT "bookingId" FROM "Attendee" WHERE "id" = 1').first("bookingId")).toBe(7);
  });

  it("reports P2025 and commits nothing when the typed guard matches no row", async () => {
    await expect(
      runD1Batch(
        db,
        [
          requireD1RecordFor(
            db,
            { modelName: "Attendee", operation: "a delete" },
            kysely.selectFrom("Attendee").select("id").where("id", "=", 99)
          ),
          compileD1Statement(db, kysely.deleteFrom("Attendee").where("id", "=", 99)),
        ],
        { modelName: "Attendee" }
      )
    ).rejects.toMatchObject({
      code: "P2025",
      meta: { modelName: "Attendee", operation: "a delete" },
    });

    expect(await db.prepare('SELECT COUNT(*) AS "total" FROM "Attendee"').first("total")).toBe(2);
  });

  it("returns the rows a compiled insert declares", async () => {
    const [result] = await runD1Batch(
      db,
      [
        compileD1Statement(
          db,
          kysely
            .insertInto("Attendee")
            .values({ email: "three@example.invalid", name: "Three", timeZone: "UTC", bookingId: 3 })
            .returning(["id", "bookingId"])
        ),
      ],
      { modelName: "Attendee" }
    );

    expect(result.results[0]).toEqual({ id: 3, bookingId: 3 });
  });
});
