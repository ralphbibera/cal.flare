import kysely from "@calcom/kysely";
import prisma from "@calcom/prisma";
import type { Booking, EventType, User } from "@calcom/prisma/client";
import { withD1Database } from "@calcom/prisma/d1";
import { BookingStatus } from "@calcom/prisma/enums";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect, it, vi } from "vitest";
import { getBookings } from "./get.handler";

let user1: User;
let user2: User;
let eventType1: EventType;
let booking1: Booking;
let booking2: Booking;
let booking3: Booking;

const timestamp = Date.now();
const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
  env: { OTHER: { type: "d1", name: "booking-list-other", dev: { remote: false } } },
});

describe("getBookings - integration", () => {
  d1.beforeAll(() => seedBookings(), 120_000);

  const seedBookings = async () => {
    user1 = await prisma.user.create({
      data: {
        username: `getbookings-user1-${timestamp}`,
        email: `getbookings-user1-${timestamp}@example.com`,
        name: "GetBookings User 1",
      },
    });

    user2 = await prisma.user.create({
      data: {
        username: `getbookings-user2-${timestamp}`,
        email: `getbookings-user2-${timestamp}@example.com`,
        name: "GetBookings User 2",
      },
    });

    eventType1 = await prisma.eventType.create({
      data: {
        title: `GetBookings Event ${timestamp}`,
        slug: `getbookings-event-${timestamp}`,
        length: 30,
        userId: user1.id,
      },
    });

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const futureDate2 = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const futureDate3 = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);

    booking1 = await prisma.booking.create({
      data: {
        uid: `getbookings-booking1-${timestamp}`,
        title: "Booking 1",
        startTime: futureDate,
        endTime: new Date(futureDate.getTime() + 30 * 60 * 1000),
        userId: user1.id,
        eventTypeId: eventType1.id,
        status: BookingStatus.ACCEPTED,
        attendees: {
          create: {
            email: user2.email,
            name: user2.name ?? "User 2",
            timeZone: "UTC",
          },
        },
      },
    });

    booking2 = await prisma.booking.create({
      data: {
        uid: `getbookings-booking2-${timestamp}`,
        title: "Booking 2",
        startTime: futureDate2,
        endTime: new Date(futureDate2.getTime() + 30 * 60 * 1000),
        userId: user1.id,
        eventTypeId: eventType1.id,
        status: BookingStatus.ACCEPTED,
        attendees: {
          create: {
            email: `getbookings-external-${timestamp}@example.com`,
            name: "External Attendee",
            timeZone: "UTC",
          },
        },
      },
    });

    booking3 = await prisma.booking.create({
      data: {
        uid: `getbookings-booking3-${timestamp}`,
        title: "Booking 3",
        startTime: futureDate3,
        endTime: new Date(futureDate3.getTime() + 30 * 60 * 1000),
        userId: user2.id,
        eventTypeId: eventType1.id,
        status: BookingStatus.ACCEPTED,
        attendees: {
          create: {
            email: user1.email,
            name: user1.name ?? "User 1",
            timeZone: "UTC",
          },
        },
      },
    });
  };

  d1.afterAll(() => vi.useRealTimers());

  d1.it("should return bookings created by the user", async () => {
    const result = await getBookings({
      user: { id: user1.id, email: user1.email, orgId: null },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 50,
      skip: 0,
    });

    const bookingIds = result.bookings.map((b) => b.id);
    expect(bookingIds).toContain(booking1.id);
    expect(bookingIds).toContain(booking2.id);
  });

  d1.it("should return bookings where user is an attendee", async () => {
    const result = await getBookings({
      user: { id: user1.id, email: user1.email, orgId: null },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 50,
      skip: 0,
    });

    const bookingIds = result.bookings.map((b) => b.id);
    expect(bookingIds).toContain(booking3.id);
  });

  d1.it("should not return duplicate bookings when user is both creator and attendee matches", async () => {
    const result = await getBookings({
      user: { id: user1.id, email: user1.email, orgId: null },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 50,
      skip: 0,
    });

    const testBookingIds = [booking1.id, booking2.id, booking3.id];
    const relevantBookingIds = result.bookings.map((b) => b.id).filter((id) => testBookingIds.includes(id));

    const uniqueIds = new Set(relevantBookingIds);
    expect(relevantBookingIds.length).toBe(uniqueIds.size);
  });

  d1.it("should return correct totalCount without duplicates", async () => {
    const resultUser1 = await getBookings({
      user: { id: user1.id, email: user1.email, orgId: null },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 50,
      skip: 0,
    });

    const expectedBookingIds = [booking1.id, booking2.id, booking3.id];
    const returnedIds = resultUser1.bookings.map((b) => b.id);
    for (const id of expectedBookingIds) {
      expect(returnedIds).toContain(id);
    }
    expect(resultUser1.totalCount).toBe(resultUser1.bookings.length);
  });

  d1.it("should respect pagination with correct ordering", async () => {
    const page1 = await getBookings({
      user: { id: user1.id, email: user1.email, orgId: null },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 1,
      skip: 0,
    });

    const page2 = await getBookings({
      user: { id: user1.id, email: user1.email, orgId: null },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 1,
      skip: 1,
    });

    expect(page1.bookings.length).toBe(1);
    expect(page2.bookings.length).toBe(1);
    expect(page1.bookings[0].id).not.toBe(page2.bookings[0].id);

    const date1 = new Date(page1.bookings[0].startTime);
    const date2 = new Date(page2.bookings[0].startTime);
    expect(date1.getTime()).toBeLessThanOrEqual(date2.getTime());
  });

  d1.it("should return bookings for user2 including those where user2 is an attendee", async () => {
    const result = await getBookings({
      user: { id: user2.id, email: user2.email, orgId: null },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 50,
      skip: 0,
    });

    const bookingIds = result.bookings.map((b) => b.id);
    expect(bookingIds).toContain(booking3.id);
    expect(bookingIds).toContain(booking1.id);
  });

  it("requires a request binding and refuses interactive transactions", async () => {
    await expect(kysely.selectFrom("Booking").select("id").execute()).rejects.toThrow("D1 request binding");
    await expect(d1.run(() => kysely.transaction().execute(async () => "unreachable"))).rejects.toThrow(
      "D1 interactive transactions are unsupported"
    );
  });

  d1.it(
    "keeps nested DTOs, nullable booleans, JSON scalar text and ordered assignment reasons",
    async () => {
      const literal = '{"title":"literal"}';
      await prisma.eventType.update({
        where: { id: eventType1.id },
        data: {
          title: literal,
          schedulingType: "ROUND_ROBIN",
          disableGuests: true,
          seatsShowAttendees: false,
          metadata: {},
          bookingFields: [{ name: "literal", label: literal }],
          hosts: { create: { userId: user1.id } },
          hostGroups: { create: { name: literal } },
        },
      });
      const created = new Date("2026-11-05T12:34:56.789Z");
      await prisma.booking.update({
        where: { id: booking1.id },
        data: {
          title: literal,
          description: "[literal]",
          createdAt: created,
          paid: true,
          rescheduled: null,
          customInputs: literal,
          responses: { text: literal },
          metadata: { nested: literal },
          isRecorded: true,
          payment: {
            create: {
              uid: "payment",
              externalId: "payment",
              amount: 120,
              fee: 0,
              currency: "usd",
              success: true,
              refunded: false,
              data: {},
            },
          },
          references: { create: { type: literal, uid: "reference", deleted: false } },
          attendees: {
            create: { name: literal, email: "literal@example.com", timeZone: "UTC", noShow: null },
          },
          assignmentReason: {
            create: [
              {
                createdAt: new Date("2026-11-05T12:34:56.790Z"),
                reasonEnum: "REASSIGNED",
                reasonString: literal,
              },
              { createdAt: created, reasonEnum: "REROUTED", reasonString: "first" },
            ],
          },
          report: {
            create: { reason: "SPAM", bookerEmail: user2.email, description: literal, createdAt: created },
          },
        },
      });
      const result = await getBookings({
        user: user1,
        prisma,
        kysely,
        bookingListingByStatus: ["upcoming"],
        filters: { bookingUid: booking1.uid },
        take: 10,
        skip: 0,
      });
      expect(result.bookings).toHaveLength(1);
      expect(result.bookings[0]).toMatchObject({
        title: literal,
        description: "[literal]",
        createdAt: created,
        paid: true,
        rescheduled: null,
        customInputs: literal,
        responses: { text: literal },
        metadata: { nested: literal },
        isRecorded: true,
        status: BookingStatus.ACCEPTED,
        eventType: {
          title: literal,
          schedulingType: "ROUND_ROBIN",
          disableGuests: true,
          seatsShowAttendees: false,
          bookingFields: [{ name: "literal", label: literal }],
          hosts: [{ userId: user1.id, user: { id: user1.id, email: user1.email } }],
          hostGroups: [{ name: literal }],
          team: null,
        },
        references: [{ type: literal, deleted: false }],
        payment: [
          {
            amount: 120,
            currency: "usd",
            success: true,
            refunded: false,
            appId: null,
            paymentOption: "ON_BOOKING",
          },
        ],
        report: { reason: "SPAM", description: literal, createdAt: "2026-11-05T12:34:56.789" },
      });
      expect(result.bookings[0].attendees.find(({ email }) => email === "literal@example.com")).toMatchObject(
        { name: literal, noShow: null }
      );
      expect(
        result.bookings[0].assignmentReasonSortedByCreatedAt.map(({ reasonString }) => reasonString)
      ).toEqual(["first", literal]);
      expect(result.bookings[0]).not.toHaveProperty("assignmentReason");
    }
  );

  d1.it(
    "applies UTC millisecond boundaries, updatedAt null ordering and parameterized attendee filters",
    async () => {
      const now = new Date("2040-01-01T00:00:00.123Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const data = {
          userId: user1.id,
          title: "Boundary",
          startTime: new Date(now.getTime() - 60_000),
          status: BookingStatus.ACCEPTED,
        };
        const before = await prisma.booking.create({
          data: {
            ...data,
            uid: "boundary-before",
            startTime: new Date(data.startTime.getTime() - 1),
            endTime: new Date(now.getTime() - 1),
          },
        });
        const exact = await prisma.booking.create({ data: { ...data, uid: "boundary-exact", endTime: now } });
        const after = await prisma.booking.create({
          data: {
            ...data,
            uid: "boundary-after",
            startTime: new Date(data.startTime.getTime() + 1),
            endTime: new Date(now.getTime() + 1),
            attendees: { create: { name: "O'NEIL", email: "boundary@example.com", timeZone: "UTC" } },
          },
        });
        const list = (
          statuses: ("upcoming" | "past")[],
          filters: Parameters<typeof getBookings>[0]["filters"] = {}
        ) =>
          getBookings({
            user: user1,
            prisma,
            kysely,
            bookingListingByStatus: statuses,
            filters,
            take: 100,
            skip: 0,
          });
        expect((await list(["upcoming"])).bookings.map(({ id }) => id)).toEqual([exact.id, after.id]);
        expect((await list(["past"], { bookingUid: before.uid })).bookings.map(({ id }) => id)).toEqual([
          before.id,
        ]);
        expect(
          (await list(["upcoming"], { beforeEndDate: now.toISOString() })).bookings.map(({ id }) => id)
        ).toEqual([exact.id]);
        expect(
          (await list(["upcoming"], { afterStartDate: data.startTime.toISOString() })).bookings
        ).toHaveLength(2);
        expect(
          (
            await list(["upcoming"], {
              attendeeName: { type: "t", data: { operator: "contains", operand: "o'nei" } },
            })
          ).bookings.map(({ id }) => id)
        ).toEqual([after.id]);
        expect((await list(["upcoming"], { attendeeName: "' OR 1=1 --" })).bookings).toEqual([]);
        await d1.db.prepare("UPDATE Booking SET updatedAt = NULL WHERE id = ?").bind(exact.id).run();
        const sorted = await getBookings({
          user: user1,
          prisma,
          kysely,
          bookingListingByStatus: ["upcoming"],
          filters: {},
          take: 1,
          skip: 0,
          sort: { sortUpdated: "asc" },
        });
        expect(sorted.bookings.map(({ id }) => id)).toEqual([after.id]);
        const nullFirst = await getBookings({
          user: user1,
          prisma,
          kysely,
          bookingListingByStatus: ["upcoming"],
          filters: {},
          take: 1,
          skip: 0,
          sort: { sortUpdated: "desc" },
        });
        expect(nullFirst.bookings[0]).toMatchObject({
          id: exact.id,
          updatedAt: null,
          paid: false,
          eventType: { price: 0 },
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  d1.it("keeps ownership and user filter denial", async () => {
    await expect(
      getBookings({
        user: user1,
        prisma,
        kysely,
        bookingListingByStatus: ["upcoming"],
        filters: { userIds: [user2.id] },
        take: 10,
        skip: 0,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = await getBookings({
      user: { id: -1, email: "outsider@example.com" },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 10,
      skip: 0,
    });
    expect(result).toMatchObject({ bookings: [], totalCount: 0, recurringInfo: [] });
  });

  d1.it("resolves overlapping Kysely requests independently across awaits", async () => {
    const other = await d1.runtime.getD1Database("OTHER");
    await other.prepare("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)").run();
    await other.prepare("INSERT INTO users VALUES (?, ?)").bind(user1.id, "other@example.com").run();
    const started = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const firstQuery = d1.run(async () => {
      const row = await kysely
        .selectFrom("users")
        .select("email")
        .where("id", "=", user1.id)
        .executeTakeFirstOrThrow();
      started.resolve();
      await second.promise;
      return [
        row.email,
        (
          await kysely
            .selectFrom("users")
            .select("email")
            .where("id", "=", user1.id)
            .executeTakeFirstOrThrow()
        ).email,
      ];
    });
    const otherQuery = withD1Database({ DB: other }, async () => {
      await started.promise;
      const row = await kysely
        .selectFrom("users")
        .select("email")
        .where("id", "=", user1.id)
        .executeTakeFirstOrThrow();
      second.resolve();
      return row.email;
    });
    expect(await Promise.all([firstQuery, otherQuery])).toEqual([
      [user1.email, user1.email],
      "other@example.com",
    ]);
  });

  d1.it("retains recurring summaries, managed team filters and seated attendee privacy", async () => {
    const team = await prisma.team.create({ data: { name: "Booking team" } });
    const parent = await prisma.eventType.create({
      data: { title: "Parent", slug: "parent", length: 30, teamId: team.id },
    });
    const child = await prisma.eventType.create({
      data: {
        title: "Child",
        slug: "child",
        length: 30,
        parentId: parent.id,
        seatsPerTimeSlot: 3,
        seatsShowAttendees: false,
      },
    });
    const data = {
      userId: user1.id,
      title: "Recurring",
      eventTypeId: child.id,
      recurringEventId: "series",
      status: BookingStatus.ACCEPTED,
    };
    const first = new Date("2041-01-01T00:00:00.123Z");
    const booking = await prisma.booking.create({
      data: {
        ...data,
        uid: "series-1",
        startTime: first,
        endTime: new Date(first.getTime() + 60_000),
        attendees: {
          create: [
            { name: "Booker", email: user2.email, timeZone: "UTC" },
            { name: "Private", email: "private@example.com", timeZone: "UTC" },
          ],
        },
      },
    });
    const attendee = await prisma.attendee.findFirstOrThrow({
      where: { bookingId: booking.id, email: user2.email },
    });
    await prisma.bookingSeat.create({
      data: { referenceUid: "series-seat", bookingId: booking.id, attendeeId: attendee.id },
    });
    await prisma.booking.create({
      data: {
        ...data,
        uid: "series-2",
        startTime: new Date("2041-01-02T00:00:00.123Z"),
        endTime: new Date("2041-01-02T00:01:00.123Z"),
      },
    });
    const result = await getBookings({
      user: user1,
      prisma,
      kysely,
      bookingListingByStatus: ["recurring"],
      filters: { teamIds: [team.id], eventTypeIds: [parent.id], userIds: [user1.id] },
      take: 1,
      skip: 0,
    });
    expect(result.totalCount).toBe(2);
    expect(result.bookings.map(({ id }) => id)).toEqual([booking.id]);
    expect(result.recurringInfo).toEqual([
      {
        recurringEventId: "series",
        count: 2,
        firstDate: first,
        bookings: {
          ACCEPTED: [first, new Date("2041-01-02T00:00:00.123Z")],
          CANCELLED: [],
          REJECTED: [],
          PENDING: [],
          AWAITING_HOST: [],
        },
      },
    ]);
    const guest = await getBookings({
      user: user2,
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: { bookingUid: booking.uid },
      take: 10,
      skip: 0,
    });
    expect(guest.bookings[0].attendees.map(({ email }) => email)).toEqual([user2.email]);
    expect(guest.bookings[0].seatsReferences).toEqual([
      { referenceUid: "series-seat", attendee: { email: user2.email } },
    ]);
    expect(result.bookings[0].attendees).toHaveLength(2);
  });

  d1.it(
    "preserves PostgreSQL nested JSON timestamp formatting without changing top-level dates",
    async () => {
      for (const [iso, nested] of [
        ["2042-01-01T00:00:00.000Z", "2042-01-01T00:00:00"],
        ["2042-01-01T00:00:00.120Z", "2042-01-01T00:00:00.12"],
        ["2042-01-01T00:00:00.100Z", "2042-01-01T00:00:00.1"],
        ["2042-01-01T00:00:00.123Z", "2042-01-01T00:00:00.123"],
        ["2041-12-31T23:59:59.999Z", "2041-12-31T23:59:59.999"],
      ]) {
        const createdAt = new Date(iso);
        await prisma.bookingReport.update({ where: { bookingUid: booking1.uid }, data: { createdAt } });
        await prisma.assignmentReason.updateMany({ where: { bookingId: booking1.id }, data: { createdAt } });
        const result = await getBookings({
          user: user1,
          prisma,
          kysely,
          bookingListingByStatus: ["upcoming"],
          filters: { bookingUid: booking1.uid },
          take: 10,
          skip: 0,
        });
        expect(result.bookings[0].report?.createdAt).toBe(nested);
        expect(
          result.bookings[0].assignmentReasonSortedByCreatedAt.map(({ createdAt }) => createdAt)
        ).toEqual([nested, nested]);
        expect(result.bookings[0].createdAt).toEqual(new Date("2026-11-05T12:34:56.789Z"));
        expect(result.bookings[0].updatedAt).toBeInstanceOf(Date);
      }
      const result = await getBookings({
        user: user1,
        prisma,
        kysely,
        bookingListingByStatus: ["upcoming"],
        filters: { bookingUid: booking2.uid },
        take: 10,
        skip: 0,
      });
      expect(result.bookings[0]).toMatchObject({ report: null, assignmentReasonSortedByCreatedAt: [] });
    }
  );

  d1.it("lists bookings reported with a mapped BookingReportReason", async () => {
    await prisma.bookingReport.upsert({
      where: { bookingUid: booking1.uid },
      update: { reason: "DONT_KNOW_PERSON" },
      create: { bookingUid: booking1.uid, bookerEmail: user2.email, reason: "DONT_KNOW_PERSON" },
    });
    const result = await getBookings({
      user: user1,
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: { bookingUid: booking1.uid },
      take: 10,
      skip: 0,
    });
    expect(result.bookings[0].report?.reason).toBe("DONT_KNOW_PERSON");
  });

  d1.it("matches advanced attendee text filters as PostgreSQL ILIKE and lower() do", async () => {
    const owner = await prisma.user.create({
      data: { username: `ilike-${timestamp}`, email: `ilike-${timestamp}@example.com`, name: "Owner" },
    });
    const startTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const [accented, plain, percent, kelvin] = await Promise.all(
      [
        { name: "ÉMILE ZOË", email: "Émile@Example.com" },
        { name: "Emile Plain", email: "emile@example.com" },
        { name: "50% off", email: "percent@example.com" },
        { name: "\u212Aelvin 500", email: "kelvin@example.com" },
      ].map((attendee, index) =>
        prisma.booking.create({
          data: {
            uid: `ilike-${index}-${timestamp}`,
            title: "ILIKE",
            userId: owner.id,
            status: BookingStatus.ACCEPTED,
            startTime: new Date(startTime.getTime() + index * 60_000),
            endTime: new Date(startTime.getTime() + index * 60_000 + 30_000),
            attendees: { create: { ...attendee, timeZone: "UTC" } },
          },
        })
      )
    );
    const filter = async (
      key: "attendeeName" | "attendeeEmail",
      operator: "contains" | "notContains" | "startsWith" | "endsWith" | "equals" | "notEquals",
      operand: string
    ) => {
      const result = await getBookings({
        user: { id: owner.id, email: owner.email, orgId: null },
        prisma,
        kysely,
        bookingListingByStatus: ["upcoming"],
        filters: { [key]: { type: "t", data: { operator, operand } } },
        take: 10,
        skip: 0,
      });
      expect(result.totalCount).toBe(result.bookings.length);
      return result.bookings.map(({ id }) => id);
    };

    expect(await filter("attendeeName", "contains", "émile")).toEqual([accented.id]);
    expect(await filter("attendeeName", "notContains", "émile")).toEqual([plain.id, percent.id, kelvin.id]);
    expect(await filter("attendeeName", "startsWith", "ÉM")).toEqual([accented.id]);
    expect(await filter("attendeeName", "endsWith", "zoë")).toEqual([accented.id]);
    expect(await filter("attendeeName", "equals", "émile zoë")).toEqual([accented.id]);
    expect(await filter("attendeeName", "notEquals", "Émile Zoë")).toEqual([plain.id, percent.id, kelvin.id]);
    expect(await filter("attendeeName", "contains", "kelvin")).toEqual([kelvin.id]);
    expect(await filter("attendeeName", "contains", "50\\%")).toEqual([percent.id]);
    expect(await filter("attendeeName", "contains", "5_0")).toEqual([kelvin.id]);
    expect(await filter("attendeeEmail", "equals", "ÉMILE@EXAMPLE.COM")).toEqual([accented.id]);
  });
});
