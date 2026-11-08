import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { BookingStatus } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitPaymentSuccessInD1 } from "./handlePaymentSuccessInD1";

const originalDate = "2026-11-05T00:00:00.000+00:00";

describe("handlePaymentSuccess atomic commit on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  const commit = (overrides: Partial<Parameters<typeof commitPaymentSuccessInD1>[0]> = {}) =>
    withD1Database({ DB: db }, () =>
      commitPaymentSuccessInD1({
        paymentId: 100,
        bookingId: 1,
        status: BookingStatus.ACCEPTED,
        referencesToCreate: [],
        ...overrides,
      })
    );
  const paymentSuccess = () =>
    db.prepare('SELECT "success" FROM "Payment" WHERE "id" = 100').first("success");
  const bookingState = () =>
    db.prepare('SELECT "paid", "status", "updatedAt" FROM "Booking" WHERE "id" = 1').first();
  const references = () =>
    db
      .prepare(
        'SELECT "type", "uid", "meetingUrl", "credentialId", "delegationCredentialId", "bookingId" FROM "BookingReference" ORDER BY "id"'
      )
      .all();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-payment-success-"));
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
      db.prepare('DROP TRIGGER IF EXISTS "fail_reference_insert"'),
      db.prepare('DELETE FROM "BookingReference"'),
      db.prepare('DELETE FROM "Payment"'),
      db.prepare('DELETE FROM "Booking"'),
      db
        .prepare(
          `INSERT INTO "Booking" ("id", "uid", "title", "startTime", "endTime", "status", "paid", "updatedAt")
          VALUES (1, 'paid-booking', 'Payment success', ?, ?, 'pending', 0, ?)`
        )
        .bind(originalDate, originalDate, originalDate),
      db.prepare(
        `INSERT INTO "Payment" ("id", "uid", "bookingId", "amount", "fee", "currency", "success", "refunded", "data", "externalId")
          VALUES (100, 'payment-uid', 1, 1000, 0, 'USD', 0, 0, '{}', 'ext-1')`
      ),
    ]);
  });

  it("commits the receipt, paid flag, status and references together", async () => {
    const result = await commit({
      referencesToCreate: [
        { type: "daily_video", uid: "ref-1", meetingUrl: "https://meet.example.invalid/ref-1" },
      ],
    });

    expect(result).toEqual({
      payment: { id: 100, externalId: "ext-1" },
      booking: { status: BookingStatus.ACCEPTED },
    });
    expect(await paymentSuccess()).toBe(1);
    const state = await bookingState();
    expect(state).toMatchObject({ paid: 1, status: "accepted" });
    expect(String(state?.updatedAt)).toMatch(/\+00:00$/);
    expect(String(state?.updatedAt)).not.toBe(originalDate);
    expect((await references()).results).toEqual([
      {
        type: "daily_video",
        uid: "ref-1",
        meetingUrl: "https://meet.example.invalid/ref-1",
        credentialId: null,
        delegationCredentialId: null,
        bookingId: 1,
      },
    ]);
  });

  it("keeps the booking status when confirmation is still required", async () => {
    const result = await commit({ status: undefined });

    expect(result.booking).toEqual({ status: BookingStatus.PENDING });
    expect(await bookingState()).toMatchObject({ paid: 1, status: "pending" });
  });

  it("rolls back the receipt and booking when a later reference write fails", async () => {
    await db
      .prepare(
        `CREATE TRIGGER "fail_reference_insert" BEFORE INSERT ON "BookingReference"
        BEGIN SELECT RAISE(ABORT, 'forced reference failure'); END`
      )
      .run();

    await expect(commit({ referencesToCreate: [{ type: "daily_video", uid: "ref-fail" }] })).rejects.toThrow(
      "forced reference failure"
    );

    expect(await paymentSuccess()).toBe(0);
    expect(await bookingState()).toMatchObject({ paid: 0, status: "pending", updatedAt: originalDate });
    expect((await references()).results).toEqual([]);
  });

  it("converges on repeated delivery", async () => {
    await commit();
    await commit();

    expect(await paymentSuccess()).toBe(1);
    expect(await bookingState()).toMatchObject({ paid: 1, status: "accepted" });
    expect(await db.prepare('SELECT COUNT(*) AS "total" FROM "Payment"').first("total")).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS "total" FROM "Booking"').first("total")).toBe(1);
  });

  it("converges when concurrent deliveries race", async () => {
    const results = await Promise.allSettled([commit(), commit()]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await paymentSuccess()).toBe(1);
    expect(await bookingState()).toMatchObject({ paid: 1, status: "accepted" });
    expect(await db.prepare('SELECT COUNT(*) AS "total" FROM "Payment"').first("total")).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS "total" FROM "Booking"').first("total")).toBe(1);
  });

  it("maps missing rows to P2025 and rolls back the earlier update", async () => {
    await expect(commit({ paymentId: -1 })).rejects.toMatchObject({
      code: "P2025",
      meta: { modelName: "Payment", operation: "an update" },
    });
    expect(await bookingState()).toMatchObject({ paid: 0, status: "pending" });

    await expect(commit({ bookingId: -1 })).rejects.toMatchObject({
      code: "P2025",
      meta: { modelName: "Booking", operation: "an update" },
    });
    expect(await paymentSuccess()).toBe(0);
  });

  it("maps dependent reference constraint failures to the original Prisma codes", async () => {
    await expect(
      commit({ referencesToCreate: [{ type: "daily_video", uid: "ref-fk", credentialId: -1 }] })
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await paymentSuccess()).toBe(0);
    expect(await bookingState()).toMatchObject({ paid: 0 });

    await db
      .prepare(
        `CREATE TRIGGER "fail_reference_insert" BEFORE INSERT ON "BookingReference"
        BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: BookingReference.type'); END`
      )
      .run();
    await expect(
      commit({ referencesToCreate: [{ type: "daily_video", uid: "ref-null" }] })
    ).rejects.toMatchObject({ code: "P2011" });
    await db.prepare('DROP TRIGGER "fail_reference_insert"').run();

    await db
      .prepare(
        `CREATE TRIGGER "fail_reference_insert" BEFORE INSERT ON "BookingReference"
        BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: BookingReference.uid'); END`
      )
      .run();
    await expect(
      commit({ referencesToCreate: [{ type: "daily_video", uid: "ref-unique" }] })
    ).rejects.toMatchObject({
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["uid"] } },
        },
      },
    });
    expect(await paymentSuccess()).toBe(0);
    expect((await references()).results).toEqual([]);
  });
});
