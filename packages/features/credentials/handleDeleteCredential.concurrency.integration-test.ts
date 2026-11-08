import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect, vi } from "vitest";
import handleDeleteCredential from "./handleDeleteCredential";

vi.mock("@calcom/features/bookings/lib/payment/deletePayment", () => ({ deletePayment: vi.fn() }));
vi.mock("@calcom/emails/email-manager", () => ({ sendCancelledEmailsAndSMS: vi.fn() }));

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../apps/web/cloudflare.config")).default.worker,
  setupTimeout: 60_000,
});

const UNPAID = [1, 2, 3];
const PAID = 1001;
const PAST = 1002;
const future = "2099-01-01T00:00:00.000+00:00";

describe("removing the same payment credential twice", () => {
  const removePaymentApp = () => handleDeleteCredential({ userId: 1, userMetadata: {}, credentialId: 1 });

  const ids = async (sql: string) =>
    (await d1.db.prepare(sql).all<{ id: number }>()).results.map(({ id }) => id);

  const booking = (id: number, startTime: string, success: number) => [
    d1.db
      .prepare(
        `INSERT INTO "Booking" ("id", "uid", "title", "description", "startTime", "endTime", "userId", "eventTypeId", "status", "paid")
         VALUES (?, ?, 'Paid', '', ?, ?, 1, 1, 'pending', 0)`
      )
      .bind(id, `booking-${id}`, startTime, startTime),
    d1.db
      .prepare(
        `INSERT INTO "Payment" ("id", "uid", "appId", "bookingId", "amount", "fee", "currency", "success", "refunded", "data", "externalId")
         VALUES (?, ?, 'stripe', ?, 1000, 0, 'usd', ?, 0, '{}', ?)`
      )
      .bind(id, `payment-${id}`, id, success, `external-${id}`),
    d1.db
      .prepare(
        `INSERT INTO "Attendee" ("email", "name", "timeZone", "bookingId") VALUES ('guest@x.invalid', 'Guest', 'UTC', ?)`
      )
      .bind(id),
    d1.db
      .prepare(`INSERT INTO "BookingReference" ("type", "uid", "bookingId") VALUES ('daily_video', ?, ?)`)
      .bind(`reference-${id}`, id),
  ];

  d1.beforeEach(async () => {
    vi.clearAllMocks();
    await d1.db.batch([
      d1.db.prepare(`DELETE FROM "Booking"`),
      d1.db.prepare(`DELETE FROM "EventType"`),
      d1.db.prepare(`DELETE FROM "users"`),
      d1.db.prepare(`DELETE FROM "App"`),
      d1.db.prepare(`INSERT INTO "App" ("slug", "dirName", "categories", "enabled", "updatedAt")
        VALUES ('stripe', 'stripepayment', '["payment"]', 1, '2026-11-06T00:00:00.000+00:00')`),
      d1.db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1, 'organizer', 'organizer@x.invalid')`
      ),
      d1.db.prepare(
        `INSERT INTO "Credential" ("id", "type", "key", "appId", "userId") VALUES (1, 'stripe_payment', '{}', 'stripe', 1)`
      ),
      d1.db.prepare(`INSERT INTO "EventType" ("id", "title", "slug", "length", "userId", "price", "currency", "metadata")
        VALUES (1, 'Paid', 'paid', 30, 1, 1000, 'usd', '{"apps":{"stripe":{"enabled":true,"price":1000,"currency":"usd"}}}')`),
      ...UNPAID.flatMap((id) => booking(id, future, 0)),
      ...booking(PAID, future, 1),
      ...booking(PAST, "2020-01-01T00:00:00.000+00:00", 0),
    ]);
  });

  d1.it(
    "leaves the credential deleted and every unpaid booking cleared after one winner",
    async () => {
      // The original cleanup callback used the outer Prisma client, so it was never atomic and could
      // repeat work or notifications. This asserts only the settled end state and the single delete.
      const results = await Promise.allSettled([removePaymentApp(), removePaymentApp()]);

      expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find(({ status }) => status === "rejected")).toMatchObject({
        reason: { code: "P2025", meta: { modelName: "Credential" } },
      });
      expect(await ids(`SELECT "id" FROM "Credential"`)).toEqual([]);
      expect(
        await ids(
          `SELECT "id" FROM "Booking" WHERE "status" = 'cancelled' AND "cancellationReason" = 'Payment method removed' ORDER BY "id"`
        )
      ).toEqual(UNPAID);
      expect(await ids(`SELECT "bookingId" AS "id" FROM "Payment" ORDER BY "bookingId"`)).toEqual([
        PAID,
        PAST,
      ]);
      expect(await ids(`SELECT "bookingId" AS "id" FROM "Attendee" ORDER BY "bookingId"`)).toEqual([
        PAID,
        PAST,
      ]);
      expect(
        await ids(
          `SELECT "bookingId" AS "id" FROM "BookingReference" WHERE "deleted" = 1 ORDER BY "bookingId"`
        )
      ).toEqual(UNPAID);
      expect(await d1.db.prepare(`SELECT "hidden" FROM "EventType" WHERE "id" = 1`).first("hidden")).toBe(1);
    },
    30_000
  );
});
