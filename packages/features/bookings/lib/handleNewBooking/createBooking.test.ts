import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { BookingStatus } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mts";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BookingPersistenceInput, createBookingInD1 } from "./createBookingInD1";

describe("booking persistence", () => {
  let mf: Miniflare;
  let root: string;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "booking-persistence-"));
    await migrateD1({ persistTo: root });
    const { worker } = (await import("../../../../../apps/web/cloudflare.config")).default;
    mf = new Miniflare({
      cf: false,
      resourcePersistencePath: join(root, "v3"),
      enableDevRegistry: false,
      telemetry: { enabled: false },
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
    await db
      .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (1, ?, ?)')
      .bind("owner-uuid", "owner@example.com")
      .run();
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const input = (uid: string): BookingPersistenceInput => ({
    data: {
      uid,
      title: "Original booking",
      startTime: new Date("2026-11-05T01:02:03.456Z"),
      endTime: new Date("2026-11-05T01:32:03.456Z"),
      status: BookingStatus.PENDING,
      user: { connect: { id: 1 } },
      eventType: {},
      attendees: { createMany: { data: [{ email: "guest@example.com", name: "Guest", timeZone: "UTC" }] } },
      tracking: { create: { utm_source: "", utm_medium: "original" } },
    },
  });
  const save = (args: BookingPersistenceInput) => withD1Database({ DB: db }, () => createBookingInD1(args));

  it("retains defaults, generated relations, JSON and selected values", async () => {
    const booking = await save(input("defaults"));
    expect(booking).toMatchObject({
      uid: "defaults",
      status: BookingStatus.PENDING,
      paid: false,
      responses: null,
      metadata: null,
      scheduledJobs: [],
      idempotencyKey: null,
      isRecorded: false,
      iCalUID: "",
      iCalSequence: 0,
      user: { uuid: "owner-uuid", email: "owner@example.com", isPlatformManaged: false },
      payment: [],
      references: [],
      attendees: [{ email: "guest@example.com", locale: "en", phoneNumber: null, noShow: false }],
    });
    expect(booking.startTime).toEqual(new Date("2026-11-05T01:02:03.456Z"));
    expect(booking.createdAt).toEqual(booking.updatedAt);
    expect(booking.oneTimePassword).toMatch(/^[0-9a-f-]{36}$/);
    expect(booking.attendees[0].bookingId).toBe(booking.id);
    expect(
      await db
        .prepare(
          'SELECT "bookingId", "utm_source", "utm_medium", "utm_campaign" FROM "Tracking" WHERE "bookingId" = ?'
        )
        .bind(booking.id)
        .first()
    ).toEqual({ bookingId: booking.id, utm_source: "", utm_medium: "original", utm_campaign: null });
  });

  it("rolls cancellation and nested writes back after a late failure", async () => {
    const original = await save(input("original"));
    await db
      .prepare(
        `CREATE TRIGGER fail_tracking BEFORE INSERT ON "Tracking" WHEN NEW."utm_source" = 'fail' BEGIN SELECT RAISE(ABORT, 'late tracking failure'); END`
      )
      .run();
    const replacement = input("replacement");
    replacement.cancellation = {
      where: { id: original.id },
      data: { status: BookingStatus.CANCELLED, rescheduled: true, rescheduledBy: undefined },
    };
    replacement.data.tracking = { create: { utm_source: "fail" } };
    await expect(save(replacement)).rejects.toThrow("late tracking failure");
    expect(
      await db
        .prepare('SELECT "status", "rescheduled", "updatedAt" FROM "Booking" WHERE "id" = ?')
        .bind(original.id)
        .first()
    ).toEqual({
      status: "pending",
      rescheduled: null,
      updatedAt: original.updatedAt?.toISOString().replace("Z", "+00:00"),
    });
    expect(
      await db.prepare('SELECT "id" FROM "Booking" WHERE "uid" = ?').bind("replacement").first()
    ).toBeNull();
    expect(
      await db
        .prepare(
          'SELECT count(*) AS total FROM "Attendee" WHERE "bookingId" IS NULL OR "bookingId" NOT IN (SELECT "id" FROM "Booking")'
        )
        .first()
    ).toEqual({ total: 0 });
  });

  it("rejects missing updates and connects without partial rows", async () => {
    const missing = input("missing-original");
    missing.cancellation = {
      where: { id: -1 },
      data: { status: BookingStatus.CANCELLED, rescheduled: true, rescheduledBy: undefined },
    };
    await expect(save(missing)).rejects.toMatchObject({ code: "P2025" });
    for (const data of [
      { user: { connect: { id: -1 } } },
      { eventType: { connect: { id: -1 } } },
      { destinationCalendar: { connect: { id: -1 } } },
      { payment: { connect: { id: -1 } } },
    ]) {
      await expect(save({ data: { ...input("missing-connect").data, ...data } })).rejects.toMatchObject({
        code: "payment" in data ? "P2018" : "P2025",
      });
    }
    expect(
      await db.prepare('SELECT "id" FROM "Booking" WHERE "uid" LIKE ?').bind("missing-%").all()
    ).toMatchObject({ results: [] });
  });

  it("preserves accepted-slot uniqueness and pending-slot concurrency", async () => {
    const accepted = input("accepted");
    accepted.data.status = BookingStatus.ACCEPTED;
    const outcomes = await Promise.allSettled([
      save(accepted),
      save({ data: { ...accepted.data, uid: "conflict" } }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "P2002" },
    });
    expect(await Promise.all([save(input("pending-a")), save(input("pending-b"))])).toHaveLength(2);
  });
});
