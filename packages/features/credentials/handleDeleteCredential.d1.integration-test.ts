import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendCancelledEmailsAndSMS } from "@calcom/emails/email-manager";
import { deletePayment } from "@calcom/features/bookings/lib/payment/deletePayment";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import handleDeleteCredential from "./handleDeleteCredential";
import { commitPaymentAppCleanupInD1 } from "./repositories/commitPaymentAppCleanupInD1";

vi.mock("@calcom/features/bookings/lib/payment/deletePayment", () => ({ deletePayment: vi.fn() }));
vi.mock("@calcom/emails/email-manager", () => ({ sendCancelledEmailsAndSMS: vi.fn() }));

const UNPAID = 250;
const unpaidIds = Array.from({ length: UNPAID }, (_, index) => index + 1);
const PAID = 1001;
const PAST = 1002;
const FAILING = 125;

describe("removing a payment app with unpaid bookings past D1's bind limit", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const removePaymentApp = () =>
    withD1Database({ DB: db }, () =>
      handleDeleteCredential({ userId: 1, userMetadata: {}, credentialId: 1 })
    );
  const ids = async (sql: string) =>
    (await db.prepare(sql).all<{ id: number }>()).results.map(({ id }) => id);
  const failOn = (trigger: string) =>
    db.prepare(`CREATE TRIGGER "fail_row" ${trigger} BEGIN SELECT RAISE(ABORT, 'forced failure'); END`).run();
  const eventTypeState = () =>
    db
      .prepare('SELECT "hidden", "metadata", "updatedAt" FROM "EventType" WHERE "id" = 1')
      .first<{ hidden: number; metadata: string; updatedAt: string | null }>();
  const bookingStatus = (id: number) =>
    db.prepare('SELECT "status" FROM "Booking" WHERE "id" = ?').bind(id).first<string>("status");
  const cleanup = (overrides: Partial<Parameters<typeof commitPaymentAppCleanupInD1>[0]> = {}) =>
    withD1Database({ DB: db }, () =>
      commitPaymentAppCleanupInD1({
        eventTypeId: 1,
        eventTypeMetadata: { apps: {} },
        bookingIds: [1],
        paymentIds: [1],
        ...overrides,
      })
    );
  const booking = (id: number, startTime: string, success: number) => [
    db
      .prepare(`INSERT INTO "Booking" ("id", "uid", "title", "description", "startTime", "endTime", "userId", "eventTypeId", "status", "paid")
        VALUES (?, ?, 'Paid', '', ?, ?, 1, 1, 'pending', 0)`)
      .bind(id, `booking-${id}`, startTime, startTime),
    db
      .prepare(`INSERT INTO "Payment" ("id", "uid", "appId", "bookingId", "amount", "fee", "currency", "success", "refunded", "data", "externalId")
        VALUES (?, ?, 'stripe', ?, 1000, 0, 'usd', ?, 0, '{}', ?)`)
      .bind(id, `payment-${id}`, id, success, `external-${id}`),
    db
      .prepare(
        `INSERT INTO "Attendee" ("email", "name", "timeZone", "bookingId") VALUES ('guest@x.invalid', 'Guest', 'UTC', ?)`
      )
      .bind(id),
    db
      .prepare(`INSERT INTO "BookingReference" ("type", "uid", "bookingId") VALUES ('daily_video', ?, ?)`)
      .bind(`reference-${id}`, id),
  ];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-delete-credential-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../apps/web/cloudflare.config")).default;
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
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    await db.batch([
      db.prepare(`DROP TRIGGER IF EXISTS "fail_row"`),
      db.prepare(`DELETE FROM "Booking"`),
      db.prepare(`DELETE FROM "EventType"`),
      db.prepare(`DELETE FROM "users"`),
      db.prepare(`DELETE FROM "App"`),
      db.prepare(`INSERT INTO "App" ("slug", "dirName", "categories", "enabled", "updatedAt")
        VALUES ('stripe', 'stripepayment', '["payment"]', 1, '2026-11-06T00:00:00.000+00:00')`),
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1, 'organizer', 'organizer@x.invalid')`
      ),
      db.prepare(
        `INSERT INTO "Credential" ("id", "type", "key", "appId", "userId") VALUES (1, 'stripe_payment', '{}', 'stripe', 1)`
      ),
      db.prepare(`INSERT INTO "EventType" ("id", "title", "slug", "length", "userId", "price", "currency", "metadata")
        VALUES (1, 'Paid', 'paid', 30, 1, 1000, 'usd', '{"apps":{"stripe":{"enabled":true,"price":1000,"currency":"usd"}}}')`),
      ...booking(PAID, "2099-01-01T00:00:00.000+00:00", 1),
      ...booking(PAST, "2020-01-01T00:00:00.000+00:00", 0),
    ]);
    for (let index = 0; index < UNPAID; index += 25) {
      await db.batch(
        unpaidIds
          .slice(index, index + 25)
          .flatMap((id) => booking(id, `2099-01-02T00:${String(id % 60).padStart(2, "0")}:00.000+00:00`, 0))
      );
    }
  });

  it("cancels every unpaid future booking and clears its payment, attendees and references", async () => {
    await removePaymentApp();

    expect(
      await ids(`SELECT "id" FROM "Booking" WHERE "status" = 'cancelled' AND "cancellationReason" = 'Payment method removed'
        AND "updatedAt" LIKE '%+00:00' ORDER BY "id"`)
    ).toEqual(unpaidIds);
    expect(await ids(`SELECT "bookingId" AS "id" FROM "Payment" ORDER BY "bookingId"`)).toEqual([PAID, PAST]);
    expect(await ids(`SELECT "bookingId" AS "id" FROM "Attendee" ORDER BY "bookingId"`)).toEqual([
      PAID,
      PAST,
    ]);
    expect(
      await ids(`SELECT "bookingId" AS "id" FROM "BookingReference" WHERE "deleted" = 1 ORDER BY "bookingId"`)
    ).toEqual(unpaidIds);
    const eventType = await eventTypeState();
    expect(eventType?.hidden).toBe(1);
    expect(JSON.parse(eventType?.metadata ?? "null")).toEqual({ apps: {} });
    expect(eventType?.updatedAt).toMatch(/\+00:00$/);
    expect(await ids(`SELECT "id" FROM "Credential"`)).toEqual([]);
    expect(deletePayment).toHaveBeenCalledTimes(UNPAID);
    expect(sendCancelledEmailsAndSMS).toHaveBeenCalledTimes(UNPAID);
  });

  it("calls payment providers before the commit and sends emails after it", async () => {
    const paymentsAtProvider: number[] = [];
    vi.mocked(deletePayment).mockImplementation(async () => {
      const total = await db.prepare('SELECT COUNT(*) AS "total" FROM "Payment"').first<number>("total");
      paymentsAtProvider.push(total ?? 0);
      return true;
    });
    const statusesAtEmail: string[] = [];
    vi.mocked(sendCancelledEmailsAndSMS).mockImplementation(async () => {
      const status = await bookingStatus(1);
      if (status) statusesAtEmail.push(status);
    });

    await removePaymentApp();

    expect(paymentsAtProvider).toHaveLength(UNPAID);
    expect(paymentsAtProvider.every((total) => total === UNPAID + 2)).toBe(true);
    expect(statusesAtEmail).toHaveLength(UNPAID);
    expect(statusesAtEmail.every((status) => status === "cancelled")).toBe(true);
  });

  it("cancels no booking when one cancellation fails", async () => {
    await failOn(`BEFORE UPDATE ON "Booking" WHEN OLD."id" = ${FAILING}`);

    await expect(removePaymentApp()).rejects.toThrow("forced failure");
    expect(await ids(`SELECT "id" FROM "Booking" WHERE "status" != 'pending'`)).toEqual([]);
    expect((await eventTypeState())?.hidden).toBe(0);
    // Provider cleanup runs before the batch because deletePayment reads the Payment row. The failed batch
    // then leaves every write uncommitted, so only the provider calls happened.
    expect(deletePayment).toHaveBeenCalledTimes(UNPAID);
    expect(sendCancelledEmailsAndSMS).not.toHaveBeenCalled();
  });

  it("keeps the whole boundary unchanged when the last cleanup statement fails", async () => {
    const originalEventType = await eventTypeState();
    await failOn(`BEFORE UPDATE ON "BookingReference" WHEN OLD."bookingId" = ${FAILING}`);

    await expect(removePaymentApp()).rejects.toThrow("forced failure");
    expect(await ids(`SELECT "id" FROM "Payment"`)).toHaveLength(UNPAID + 2);
    expect(await ids(`SELECT "id" FROM "Attendee"`)).toHaveLength(UNPAID + 2);
    expect(await ids(`SELECT "id" FROM "BookingReference" WHERE "deleted" = 1`)).toEqual([]);
    expect(await ids(`SELECT "id" FROM "Booking" WHERE "status" != 'pending'`)).toEqual([]);
    expect(await eventTypeState()).toEqual(originalEventType);
    expect(await ids(`SELECT "id" FROM "Credential"`)).toEqual([1]);
    expect(deletePayment).toHaveBeenCalledTimes(UNPAID);
    expect(sendCancelledEmailsAndSMS).not.toHaveBeenCalled();
  });

  it("maps a missing event type to P2025 and rolls back the batch", async () => {
    const error = await cleanup({ eventTypeId: 999 }).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "P2025", meta: { modelName: "EventType", operation: "an update" } });
    expect(await ids(`SELECT "id" FROM "Booking" WHERE "status" != 'pending'`)).toEqual([]);
    expect(await ids(`SELECT "id" FROM "Payment"`)).toHaveLength(UNPAID + 2);
  });

  it("maps constraint failures from the batch to the original Prisma codes", async () => {
    await db
      .prepare(
        `CREATE TRIGGER "fail_row" BEFORE UPDATE ON "EventType"
        BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: EventType.metadata'); END`
      )
      .run();
    await expect(cleanup()).rejects.toMatchObject({
      code: "P2011",
      meta: { driverAdapterError: { cause: { constraint: { fields: ["metadata"] } } } },
    });
    expect(await bookingStatus(1)).toBe("pending");
    await db.prepare(`DROP TRIGGER "fail_row"`).run();

    await db
      .prepare(
        `CREATE TRIGGER "fail_row" BEFORE DELETE ON "Payment"
        BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END`
      )
      .run();
    await expect(cleanup()).rejects.toMatchObject({ code: "P2003" });
    expect(await bookingStatus(1)).toBe("pending");
    await db.prepare(`DROP TRIGGER "fail_row"`).run();

    await db
      .prepare(
        `CREATE TRIGGER "fail_row" BEFORE UPDATE ON "BookingReference"
        BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: BookingReference.uid'); END`
      )
      .run();
    await expect(cleanup()).rejects.toMatchObject({
      code: "P2002",
      meta: { driverAdapterError: { cause: { constraint: { fields: ["uid"] } } } },
    });
    expect(await bookingStatus(1)).toBe("pending");
    expect(await db.prepare('SELECT COUNT(*) AS "total" FROM "Payment"').first("total")).toBe(UNPAID + 2);
  });

  it("converges when two cleanup batches race", async () => {
    const results = await Promise.allSettled([
      cleanup({ bookingIds: [1, 2], paymentIds: [1, 2] }),
      cleanup({ bookingIds: [1, 2], paymentIds: [1, 2] }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await ids(`SELECT "id" FROM "Booking" WHERE "status" = 'cancelled' ORDER BY "id"`)).toEqual([
      1, 2,
    ]);
    expect(await ids(`SELECT "id" FROM "Payment" WHERE "id" IN (1, 2)`)).toEqual([]);
  });
});
