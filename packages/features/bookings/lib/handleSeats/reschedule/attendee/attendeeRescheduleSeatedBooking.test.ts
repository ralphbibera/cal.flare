import { sendRescheduledSeatEmailAndSMS } from "@calcom/emails/email-manager";
import lastAttendeeDeleteBooking from "@calcom/features/bookings/lib/handleSeats/lib/lastAttendeeDeleteBooking";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findBookingQuery } from "../../../handleNewBooking/findBookingQuery";
import attendeeRescheduleSeatedBooking from "./attendeeRescheduleSeatedBooking";
import { moveSeatedAttendeeInD1 } from "./moveSeatedAttendeeInD1";

vi.mock("./moveSeatedAttendeeInD1", () => ({ moveSeatedAttendeeInD1: vi.fn() }));
vi.mock("@calcom/emails/email-manager", () => ({ sendRescheduledSeatEmailAndSMS: vi.fn() }));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn() }));
vi.mock("@calcom/prisma", () => ({ default: { attendee: { delete: vi.fn() } } }));
vi.mock("@calcom/features/bookings/lib/handleSeats/lib/lastAttendeeDeleteBooking", () => ({
  default: vi.fn(),
}));
vi.mock("../../../handleNewBooking/findBookingQuery", () => ({ findBookingQuery: vi.fn() }));
vi.mock("@calcom/features/CalendarEventBuilder", () => ({
  CalendarEventBuilder: {
    fromEvent: (event: unknown) => ({
      withVideoCallDataFromReferences: () => ({ build: () => event }),
    }),
  },
}));

type Args = Parameters<typeof attendeeRescheduleSeatedBooking>;

const time = "2099-01-01T00:00:00.000Z";

const createArgs = () => {
  const seatAttendee = {
    id: 10,
    email: "seat@example.invalid",
    name: "Seat",
    timeZone: "UTC",
    locale: "en",
  };
  const bookingSeat = {
    id: 100,
    referenceUid: "seat-reference",
    bookingId: 1,
    attendeeId: 10,
    attendee: seatAttendee,
    data: null,
    metadata: null,
  };
  const evt = {
    attendees: [],
    startTime: time,
    endTime: time,
    type: "seated",
    title: "Seated",
    organizer: { name: "Host", email: "host@example.invalid", timeZone: "UTC" },
    bookerUrl: "https://example.invalid",
  };
  const reschedule = {
    tAttendees: (key: string) => key,
    bookingSeat,
    bookerEmail: seatAttendee.email,
    evt,
    eventType: { metadata: {} },
    originalRescheduledBooking: null,
  };
  const newTimeSlotBooking = {
    id: 2,
    uid: "new-booking",
    iCalUID: "ical-new",
    attendees: [],
    references: [],
  };
  const eventManager = { updateCalendarAttendees: vi.fn().mockResolvedValue(undefined) };
  return { seatAttendee, bookingSeat, evt, reschedule, newTimeSlotBooking, eventManager };
};

const reschedule = (args: ReturnType<typeof createArgs>) =>
  attendeeRescheduleSeatedBooking(
    args.reschedule as unknown as Args[0],
    args.seatAttendee as unknown as Args[1],
    args.newTimeSlotBooking as unknown as Args[2],
    args.evt as unknown as Args[3],
    args.eventManager as unknown as Args[4]
  );

describe("attendeeRescheduleSeatedBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findBookingQuery).mockResolvedValue({
      uid: "new-booking",
      status: "accepted",
    } as unknown as Awaited<ReturnType<typeof findBookingQuery>>);
    vi.mocked(lastAttendeeDeleteBooking).mockResolvedValue(false);
  });

  it("moves the attendee and seat before updating the new booking and emailing", async () => {
    const args = createArgs();

    const result = await reschedule(args);

    expect(moveSeatedAttendeeInD1).toHaveBeenCalledWith({
      attendeeId: 10,
      bookingSeatId: 100,
      bookingId: 2,
    });
    const moveOrder = vi.mocked(moveSeatedAttendeeInD1).mock.invocationCallOrder[0];
    expect(args.eventManager.updateCalendarAttendees).toHaveBeenCalledWith(
      expect.objectContaining({ iCalUID: "ical-new", attendeeSeatId: "seat-reference" }),
      args.newTimeSlotBooking
    );
    expect(args.eventManager.updateCalendarAttendees.mock.invocationCallOrder[0]).toBeGreaterThan(moveOrder);
    expect(sendRescheduledSeatEmailAndSMS).toHaveBeenCalled();
    expect(vi.mocked(sendRescheduledSeatEmailAndSMS).mock.invocationCallOrder[0]).toBeGreaterThan(moveOrder);
    expect(result).toMatchObject({ uid: "new-booking", seatReferenceUid: "seat-reference" });
  });

  it("does not update the new booking or email when the move fails", async () => {
    const args = createArgs();
    const error = Object.assign(new Error("Record to update not found"), { code: "P2025" });
    vi.mocked(moveSeatedAttendeeInD1).mockRejectedValue(error);

    await expect(reschedule(args)).rejects.toBe(error);

    expect(args.eventManager.updateCalendarAttendees).not.toHaveBeenCalled();
    expect(sendRescheduledSeatEmailAndSMS).not.toHaveBeenCalled();
    expect(findBookingQuery).not.toHaveBeenCalled();
  });
});
