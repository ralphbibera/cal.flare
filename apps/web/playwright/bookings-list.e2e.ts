import { prisma } from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";
import { expect } from "@playwright/test";
import { addFilter, applyTextFilter } from "./filter-helpers";
import type { Fixtures } from "./lib/fixtures";
import { test } from "./lib/fixtures";

test.describe.configure({ mode: "parallel" });

test.afterEach(({ users }) => users.deleteAll());

const createBooking = async ({
  bookings,
  organizer,
  attendees,
  relativeDate = 1,
  title,
  status = BookingStatus.ACCEPTED,
}: {
  bookings: Fixtures["bookings"];
  organizer: { id: number; username: string | null; eventTypes: { id: number }[] };
  attendees: { name: string; email: string; timeZone: string }[];
  relativeDate?: number;
  title: string;
  status?: BookingStatus;
}) => {
  const startTime = new Date(Date.now() + relativeDate * 24 * 60 * 60 * 1000);
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
  return bookings.create(organizer.id, organizer.username, organizer.eventTypes[0]?.id, {
    title,
    status,
    startTime,
    endTime,
    attendees: {
      createMany: {
        data: attendees,
      },
    },
  });
};

test.describe("Bookings list", () => {
  test("shows organizer and attendee bookings in ascending start date order", async ({
    page,
    users,
    bookings,
  }) => {
    const organizer = await users.create();
    const attendee = await users.create();

    await createBooking({
      bookings,
      organizer,
      relativeDate: 3,
      title: "Booking as organizer",
      attendees: [{ name: "First", email: "first@example.com", timeZone: "Europe/London" }],
    });
    await createBooking({
      bookings,
      organizer: attendee,
      relativeDate: 2,
      title: "Booking as attendee",
      attendees: [{ name: "Organizer", email: organizer.email, timeZone: "Europe/London" }],
    });

    await organizer.apiLogin();
    await page.goto("/bookings/upcoming");

    const items = page.locator('[data-testid="upcoming-bookings"] [data-testid="booking-item"]');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Booking as attendee");
    await expect(items.nth(1)).toContainText("Booking as organizer");
  });

  test("confirms an unconfirmed booking from the list", async ({ page, users, bookings }) => {
    const organizer = await users.create();
    const booking = await createBooking({
      bookings,
      organizer,
      title: "Pending confirmation",
      status: BookingStatus.PENDING,
      attendees: [{ name: "Guest", email: "guest@example.com", timeZone: "Europe/London" }],
    });

    await organizer.apiLogin();
    await page.goto("/bookings/unconfirmed");

    const item = page.locator(
      `[data-testid="unconfirmed-bookings"] [data-testid="booking-item"][data-booking-uid="${booking.uid}"]`
    );
    await expect(item).toBeVisible();
    await item.getByTestId("confirm").click();

    await expect
      .poll(async () => (await prisma.booking.findUnique({ where: { id: booking.id } }))?.status)
      .toBe(BookingStatus.ACCEPTED);

    await page.goto("/bookings/upcoming");
    await expect(
      page.locator(
        `[data-testid="upcoming-bookings"] [data-testid="booking-item"][data-booking-uid="${booking.uid}"]`
      )
    ).toBeVisible();
  });

  test("rejects an unconfirmed booking from the list", async ({ page, users, bookings }) => {
    const organizer = await users.create();
    const booking = await createBooking({
      bookings,
      organizer,
      title: "Pending rejection",
      status: BookingStatus.PENDING,
      attendees: [{ name: "Guest", email: "guest@example.com", timeZone: "Europe/London" }],
    });

    await organizer.apiLogin();
    await page.goto("/bookings/unconfirmed");

    const item = page.locator(
      `[data-testid="unconfirmed-bookings"] [data-testid="booking-item"][data-booking-uid="${booking.uid}"]`
    );
    await expect(item).toBeVisible();
    await item.getByTestId("reject").click();
    await page.getByTestId("rejection-confirm").click();

    await expect
      .poll(async () => (await prisma.booking.findUnique({ where: { id: booking.id } }))?.status)
      .toBe(BookingStatus.REJECTED);
    await expect(
      page.locator(
        `[data-testid="unconfirmed-bookings"] [data-testid="booking-item"][data-booking-uid="${booking.uid}"]`
      )
    ).toHaveCount(0);
  });

  test("cancels an upcoming booking from the list and lists it under cancelled", async ({
    page,
    users,
    bookings,
  }) => {
    const organizer = await users.create();
    const booking = await createBooking({
      bookings,
      organizer,
      title: "Cancel me",
      attendees: [{ name: "Guest", email: "guest@example.com", timeZone: "Europe/London" }],
    });

    await organizer.apiLogin();
    await page.goto("/bookings/upcoming");

    const item = page.locator(
      `[data-testid="upcoming-bookings"] [data-testid="booking-item"][data-booking-uid="${booking.uid}"]`
    );
    await expect(item).toBeVisible();
    await item.getByTestId("booking-actions-dropdown").click();
    await page.getByTestId("cancel").click();
    await expect(page.getByTestId("cancel-dialog")).toBeVisible();
    await page.getByTestId("cancel_reason").fill("Schedule conflict");
    await page.getByTestId("confirm_cancel").click();

    await expect
      .poll(async () => (await prisma.booking.findUnique({ where: { id: booking.id } }))?.status)
      .toBe(BookingStatus.CANCELLED);

    await page.goto("/bookings/cancelled");
    await expect(
      page.locator(
        `[data-testid="cancelled-bookings"] [data-testid="booking-item"][data-booking-uid="${booking.uid}"]`
      )
    ).toBeVisible();
  });

  test("upcoming date range filter has no presets, past date range filter has presets", async ({
    page,
    users,
  }) => {
    const user = await users.create();
    await user.apiLogin();

    await page.goto("/bookings/upcoming");
    await addFilter(page, "dateRange");
    await expect(page.getByTestId("date-range-options-c")).toBeHidden();
    await expect(page.getByTestId("date-range-options-w")).toBeHidden();
    await expect(page.getByTestId("date-range-options-m")).toBeHidden();
    await expect(page.getByTestId("date-range-options-y")).toBeHidden();
    await expect(page.getByTestId("date-range-options-t")).toBeHidden();
    await expect(page.getByTestId("date-range-options-tdy")).toBeHidden();
    await expect(page.getByTestId("date-range-calendar")).toBeVisible();

    await page.goto("/bookings/past");
    await addFilter(page, "dateRange");
    await expect(page.getByTestId("date-range-options-c")).toBeVisible();
    await expect(page.getByTestId("date-range-options-w")).toBeVisible();
    await expect(page.getByTestId("date-range-options-m")).toBeVisible();
    await expect(page.getByTestId("date-range-options-y")).toBeVisible();
    await expect(page.getByTestId("date-range-options-t")).toBeVisible();
    await expect(page.getByTestId("date-range-options-tdy")).toBeVisible();
    await expect(page.getByTestId("date-range-calendar")).toBeHidden();
  });

  test("filters upcoming bookings by attendee name", async ({ page, users, bookings }) => {
    const organizer = await users.create();
    await createBooking({
      bookings,
      organizer,
      title: "Matching attendee",
      attendees: [{ name: "Filter Target", email: "target@example.com", timeZone: "Europe/London" }],
    });
    await createBooking({
      bookings,
      organizer,
      title: "Other attendee",
      attendees: [{ name: "Someone Else", email: "other@example.com", timeZone: "Europe/London" }],
    });

    await organizer.apiLogin();
    await page.goto("/bookings/upcoming");

    await applyTextFilter(page, "attendeeName", "Contains", "Filter Target");

    const items = page.locator('[data-testid="upcoming-bookings"] [data-testid="booking-item"]');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Matching attendee");
  });

  test("marks a past booking guest as no-show", async ({ page, users, bookings }) => {
    const organizer = await users.create();
    await createBooking({
      bookings,
      organizer,
      relativeDate: -3,
      title: "Past booking",
      attendees: [{ name: "Guest", email: "guest@example.com", timeZone: "Europe/London" }],
    });

    await organizer.apiLogin();
    await page.goto("/bookings/past");

    const item = page.locator('[data-testid="past-bookings"] [data-testid="booking-item"]').first();
    await item.locator('[data-testid="guest"]').first().click();
    await expect(page.getByTestId("mark-no-show")).toBeVisible();
    await page.getByTestId("mark-no-show").click();
    await item.locator('[data-testid="guest"]').first().click();
    await expect(page.getByTestId("unmark-no-show")).toBeVisible();
    await expect(page.getByTestId("mark-no-show")).toBeHidden();
  });
});
