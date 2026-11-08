import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendScheduledEmailsAndSMS } from "@calcom/emails/email-manager";
import { handleBookingRequested } from "@calcom/features/bookings/lib/handleBookingRequested";
import { handleConfirmation } from "@calcom/features/bookings/lib/handleConfirmation";
import sendPayload from "@calcom/features/webhooks/lib/sendOrSchedulePayload";
import { Prisma } from "@calcom/prisma/client";
import { withD1Database } from "@calcom/prisma/d1";
import { BookingStatus, WebhookTriggerEvents } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import cloudflareConfig from "../../../../apps/web/cloudflare.config";
import { handlePaymentSuccess } from "./handlePaymentSuccess";

const mocks = vi.hoisted(() => ({
  getBooking: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  webhooks: vi.fn(),
  payload: vi.fn(),
  confirm: vi.fn(),
  request: vi.fn(),
  email: vi.fn(),
  team: vi.fn(),
  credentials: vi.fn(),
}));

vi.mock("@calcom/features/bookings/lib/payment/getBooking", () => ({ getBooking: mocks.getBooking }));
vi.mock("@calcom/features/bookings/lib/EventManager", () => ({
  default: class {
    create = mocks.create;
  },
  placeholderCreatedEvent: { results: [], referencesToCreate: [] },
}));
vi.mock("@calcom/features/tasker", () => ({ default: { cancelWithReference: mocks.cancel } }));
vi.mock("@calcom/features/webhooks/lib/getWebhooks", () => ({ default: mocks.webhooks }));
vi.mock("@calcom/features/webhooks/lib/sendOrSchedulePayload", () => ({ default: mocks.payload }));
vi.mock("@calcom/features/bookings/lib/handleConfirmation", () => ({ handleConfirmation: mocks.confirm }));
vi.mock("@calcom/features/bookings/lib/handleBookingRequested", () => ({
  handleBookingRequested: mocks.request,
}));
vi.mock("@calcom/emails/email-manager", () => ({ sendScheduledEmailsAndSMS: mocks.email }));
vi.mock("@calcom/lib/getTeamIdFromEventType", () => ({ getTeamIdFromEventType: mocks.team }));
vi.mock("@calcom/features/bookings/lib/getAllCredentialsForUsersOnEvent/getAllCredentials", () => ({
  getAllCredentialsIncludeServiceAccountKey: mocks.credentials,
}));
vi.mock("@calcom/features/platform-oauth-client/platform-oauth-client.repository", () => ({
  PlatformOAuthClientRepository: class {
    getByUserId = vi.fn().mockResolvedValue(null);
  },
}));
vi.mock("@calcom/features/platform-oauth-client/get-platform-params", () => ({ getPlatformParams: vi.fn() }));
vi.mock("@calcom/lib/tracing/factory", () => ({
  distributedTracing: {
    updateTrace: vi.fn((context) => context),
    getTracingLogger: vi.fn(() => ({ error: vi.fn() })),
  },
}));
vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

const bookingId = 1;
const paymentId = 10;
const previousUpdate = "2026-01-01T00:00:00.000+00:00";
const traceContext = { traceId: "trace-id", spanId: "span-id", operation: "payment-success" };
const subscriber = { id: "webhook-1", subscriberUrl: "https://example.invalid", secret: "webhook-secret" };
const evt = { attendees: [{ email: "guest@example.invalid" }], uid: "booking-uid", bookingId };

describe("handlePaymentSuccess on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  const deliver = () =>
    withD1Database({ DB: db }, () =>
      handlePaymentSuccess({ paymentId, appSlug: "stripe", bookingId, traceContext })
    );
  const deliverError = () => deliver().catch((error: unknown) => error);

  const bookingResult = async () => {
    const row = await db
      .prepare(
        `SELECT b."status", b."paid", e."requiresConfirmation"
        FROM "Booking" b LEFT JOIN "EventType" e ON e."id" = b."eventTypeId" WHERE b."id" = ?`
      )
      .bind(bookingId)
      .first<{ status: string; paid: number; requiresConfirmation: number }>();
    const requiresConfirmation = Boolean(row?.requiresConfirmation);
    return {
      booking: {
        id: bookingId,
        userId: 1,
        eventTypeId: 1,
        uid: "booking-uid",
        status: (row?.status ?? "pending").toUpperCase(),
        eventType: { id: 1, requiresConfirmation, metadata: {} },
      },
      user: { id: 1, isPlatformManaged: false, credentials: [] },
      evt,
      eventType: { id: 1, requiresConfirmation, metadata: {} },
    };
  };

  const paymentRow = () =>
    db
      .prepare('SELECT "success", "externalId" FROM "Payment" WHERE "id" = ?')
      .bind(paymentId)
      .first<{ success: number; externalId: string }>();
  const bookingRow = () =>
    db
      .prepare('SELECT "status", "paid", "updatedAt" FROM "Booking" WHERE "id" = ?')
      .bind(bookingId)
      .first<{ status: string; paid: number; updatedAt: string }>();
  const referenceRows = () =>
    db
      .prepare('SELECT "type", "uid", "externalCalendarId" FROM "BookingReference" ORDER BY "id"')
      .all<{ type: string; uid: string; externalCalendarId: string | null }>();

  const seedBooking = async ({
    status = "pending",
    requiresConfirmation = 0,
    withPayment = true,
  }: {
    status?: string;
    requiresConfirmation?: number;
    withPayment?: boolean;
  } = {}) => {
    await db.batch([
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email", "name", "username", "timeZone")
        VALUES (1, 'organizer-uuid', 'organizer@example.invalid', 'Organizer', 'organizer', 'UTC')`
      ),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length", "userId", "requiresConfirmation", "metadata")
        VALUES (1, 'Paid event', 'paid', 30, 1, ${requiresConfirmation}, '{}')`
      ),
      db.prepare(
        `INSERT INTO "Booking" ("id", "uid", "title", "startTime", "endTime", "userId", "eventTypeId", "status", "paid", "updatedAt")
        VALUES (1, 'booking-uid', 'Paid event', '2026-12-01T10:00:00.000+00:00', '2026-12-01T10:30:00.000+00:00', 1, 1, '${status}', 0, '${previousUpdate}')`
      ),
      ...(withPayment
        ? [
            db.prepare(
              `INSERT INTO "Payment" ("id", "uid", "bookingId", "amount", "fee", "currency", "success", "refunded", "data", "externalId")
              VALUES (10, 'payment-uid', 1, 1000, 0, 'usd', 0, 0, '{}', 'external-payment')`
            ),
          ]
        : []),
    ]);
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-payment-success-"));
    const persistTo = join(directory, "state");
    const migrated = await migrateD1({ persistTo });
    expect(migrated.applied).toBe(migrated.total);
    const { worker } = cloudflareConfig;
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
    mocks.getBooking.mockImplementation(bookingResult);
    mocks.create.mockResolvedValue({ results: [], referencesToCreate: [] });
    mocks.cancel.mockResolvedValue(undefined);
    mocks.webhooks.mockResolvedValue([]);
    mocks.payload.mockResolvedValue({ ok: true, status: 200 });
    mocks.confirm.mockResolvedValue(undefined);
    mocks.request.mockResolvedValue(undefined);
    mocks.email.mockResolvedValue(undefined);
    mocks.team.mockResolvedValue(null);
    mocks.credentials.mockResolvedValue([]);
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS "fail_reference_insert"'),
      db.prepare('DROP INDEX IF EXISTS "reference_uid_unique"'),
      db.prepare('DELETE FROM "BookingReference"'),
      db.prepare('DELETE FROM "Payment"'),
      db.prepare('DELETE FROM "Booking"'),
      db.prepare('DELETE FROM "EventType"'),
      db.prepare('DELETE FROM "users"'),
    ]);
  });

  it("commits the receipt, paid flag, status and references before the webhook", async () => {
    await seedBooking({ status: "accepted" });
    mocks.webhooks.mockResolvedValue([subscriber]);
    mocks.create.mockResolvedValue({
      results: [],
      referencesToCreate: [{ type: "daily_video", uid: "reference-uid", externalCalendarId: "calendar-id" }],
    });

    expect(await deliverError()).toMatchObject({ statusCode: 200 });
    expect(await paymentRow()).toEqual({ success: 1, externalId: "external-payment" });
    expect(await bookingRow()).toMatchObject({ status: "accepted", paid: 1 });
    expect((await referenceRows()).results).toEqual([
      { type: "daily_video", uid: "reference-uid", externalCalendarId: "calendar-id" },
    ]);
    expect(sendPayload).toHaveBeenCalledWith(
      subscriber.secret,
      WebhookTriggerEvents.BOOKING_PAID,
      expect.any(String),
      subscriber,
      expect.objectContaining({
        bookingId,
        status: BookingStatus.ACCEPTED,
        paymentId,
        metadata: expect.objectContaining({ externalId: "external-payment" }),
      })
    );
  });

  it("keeps a confirmation-required booking pending while recording the receipt and paid flag", async () => {
    await seedBooking({ requiresConfirmation: 1 });

    expect(await deliverError()).toMatchObject({ statusCode: 200 });
    expect(await paymentRow()).toEqual({ success: 1, externalId: "external-payment" });
    expect(await bookingRow()).toMatchObject({ status: "pending", paid: 1 });
    expect(handleBookingRequested).toHaveBeenCalledTimes(1);
    expect(handleConfirmation).not.toHaveBeenCalled();
  });

  it("rolls back the receipt, paid flag, status and references when a later insert fails", async () => {
    await seedBooking({ status: "accepted" });
    mocks.webhooks.mockResolvedValue([subscriber]);
    mocks.create.mockResolvedValue({
      results: [],
      referencesToCreate: [{ type: "daily_video", uid: "reference-uid" }],
    });
    await db
      .prepare(
        `CREATE TRIGGER "fail_reference_insert" BEFORE INSERT ON "BookingReference"
        BEGIN SELECT RAISE(ABORT, 'forced reference failure'); END`
      )
      .run();

    expect(await deliverError()).toMatchObject({
      message: expect.stringContaining("forced reference failure"),
    });
    expect(await paymentRow()).toEqual({ success: 0, externalId: "external-payment" });
    expect(await bookingRow()).toEqual({ status: "accepted", paid: 0, updatedAt: previousUpdate });
    expect((await referenceRows()).results).toEqual([]);
    expect(sendPayload).not.toHaveBeenCalled();
    expect(sendScheduledEmailsAndSMS).not.toHaveBeenCalled();
  });

  it("keeps one receipt and one paid booking across repeated and simultaneous delivery", async () => {
    await seedBooking();
    mocks.webhooks.mockResolvedValue([subscriber]);

    for (const result of await Promise.all([deliverError(), deliverError()]))
      expect(result).toMatchObject({ statusCode: 200 });
    expect(await deliverError()).toMatchObject({ statusCode: 200 });

    expect(await db.prepare('SELECT COUNT(*) AS "count" FROM "Payment"').first()).toEqual({ count: 1 });
    expect(await paymentRow()).toEqual({ success: 1, externalId: "external-payment" });
    expect(await bookingRow()).toMatchObject({ status: "accepted", paid: 1 });
    expect(sendPayload).toHaveBeenCalledTimes(3);
  });

  it.each([
    { missing: "payment", model: "Payment" },
    { missing: "booking", model: "Booking" },
  ])("maps a missing $missing to P2025 and rolls back every write", async ({ missing, model }) => {
    await seedBooking({ withPayment: missing !== "payment" });
    if (missing === "booking") {
      const result = await bookingResult();
      mocks.getBooking.mockResolvedValue({ ...result, booking: { ...result.booking, id: 999 } });
    }

    const error = await deliverError();

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).toMatchObject({ code: "P2025", meta: { modelName: model } });
    expect(await paymentRow()).toEqual(
      missing === "payment" ? null : { success: 0, externalId: "external-payment" }
    );
    expect(await bookingRow()).toMatchObject({ paid: 0 });
  });

  it.each([
    { references: [{ type: "daily_video", uid: "reference-uid", credentialId: 999 }], code: "P2003" },
    { references: [{ type: null, uid: "reference-uid" }], code: "P2011" },
    {
      references: [
        { type: "daily_video", uid: "duplicate" },
        { type: "daily_video", uid: "duplicate" },
      ],
      code: "P2002",
      uniqueIndex: true,
    },
  ])("maps a reference constraint failure to $code and rolls back every write", async ({
    references,
    code,
    uniqueIndex,
  }) => {
    await seedBooking({ status: "accepted" });
    if (uniqueIndex) {
      await db.prepare('CREATE UNIQUE INDEX "reference_uid_unique" ON "BookingReference" ("uid")').run();
    }
    mocks.create.mockResolvedValue({ results: [], referencesToCreate: references });

    const error = await deliverError();

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).toMatchObject({ code });
    expect(await paymentRow()).toEqual({ success: 0, externalId: "external-payment" });
    expect(await bookingRow()).toMatchObject({ status: "accepted", paid: 0 });
    expect((await referenceRows()).results).toEqual([]);
  });
});
