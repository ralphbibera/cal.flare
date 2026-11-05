import { createRequire } from "node:module";
import { ORGANIZER_EMAIL_EXEMPT_DOMAINS } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { buildCalendarEvent, buildPerson, buildVideoCallData } from "@calcom/lib/test/builder";
import { test } from "@calcom/testing/lib/fixtures/fixtures";
import type { CalendarEvent } from "@calcom/types/Calendar";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import generateIcsString from "./generateIcsString";

const assertHasIcsString = (icsString: string | undefined) => {
  if (!icsString) throw new Error("icsString is undefined");

  expect(icsString).toBeDefined();

  return icsString;
};

const calendarProperty = z
  .tuple([z.string(), z.record(z.unknown()), z.string(), z.unknown()])
  .rest(z.unknown());
const calendarComponent = z.tuple([z.string(), z.array(calendarProperty), z.array(z.unknown())]);
const calendar = z.tuple([z.literal("vcalendar"), z.array(calendarProperty), z.array(calendarComponent)]);
const parser = z
  .object({ parse: z.function().args(z.string()).returns(z.unknown()) })
  .parse(createRequire(import.meta.url)("ical.js"));

const getEventProperty = (icsString: string, name: string) => {
  const parsed = calendar.parse(parser.parse(icsString));
  const event = parsed[2].find(([type]) => type === "vevent");
  const property = event?.[1].find(([key]) => key === name);
  if (!property) throw new Error(`Calendar property ${name} is missing`);
  return { parameters: property[1], value: property[3] };
};

const testIcsStringContains = ({
  icsString,
  event,
  status,
}: {
  icsString: string;
  event: CalendarEvent;
  status: string;
}) => {
  const DTSTART = `${event.startTime.split(".")[0].split(":").slice(0, 2).join(":").replace(/[-:]/g, "")}00Z`;
  const DTEND = `${event.endTime.split(".")[0].split(":").slice(0, 2).join(":").replace(/[-:]/g, "")}00Z`;
  const isOrganizerExempt = ORGANIZER_EMAIL_EXEMPT_DOMAINS?.split(",")
    .filter((domain) => domain.trim() !== "")
    .some((domain) => event.organizer.email.toLowerCase().endsWith(domain.toLowerCase()));
  expect(icsString).toEqual(expect.stringContaining(`UID:${event.iCalUID}`));
  // Sometimes the deeply equal stringMatching error appears. Don't want to add flakey tests
  // expect(icsString).toEqual(expect.stringContaining(`SUMMARY:${event.title}`));
  expect(icsString).toEqual(expect.stringContaining(`DTSTART:${DTSTART}`));
  const organizer = getEventProperty(icsString, "organizer");
  const address = z.string().parse(organizer.value);
  expect(organizer.parameters.cn).toBe(event.organizer.name);
  expect(address).toMatch(/^mailto:/i);
  expect(address.replace(/^mailto:/i, "")).toBe(
    event.hideOrganizerEmail && !isOrganizerExempt ? "no-reply@cal.com" : event.organizer.email
  );
  expect(icsString).toEqual(expect.stringContaining(`DTEND:${DTEND}`));
  expect(icsString).toEqual(expect.stringContaining(`STATUS:${status}`));
  expect(icsString).toEqual(
    expect.stringContaining(`METHOD:${status === "CANCELLED" ? "CANCEL" : "REQUEST"}`)
  );
  //   Getting an error expected icsString to deeply equal stringMatching
  //   for (const attendee of event.attendees) {
  //     expect(icsString).toEqual(
  //       expect.stringMatching(
  //         `RSVP=TRUE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${attendee.name}:mailto:${attendee.email}`
  //       )
  //     );
  //   }
};

describe("generateIcsString", () => {
  test.each([undefined, ""])("retains the booking UID when iCalUID is %s", (iCalUID) => {
    const event = buildCalendarEvent({ iCalUID, uid: "booking-uid-1" });
    const value = assertHasIcsString(generateIcsString({ event, status: "CONFIRMED" }));
    expect(getEventProperty(value, "uid").value).toBe("booking-uid-1");
  });

  test.each([undefined, ""])("generates a UID when both event IDs are %s", (id) => {
    const event = buildCalendarEvent({ iCalUID: id, uid: id });
    const first = assertHasIcsString(generateIcsString({ event, status: "CONFIRMED" }));
    const second = assertHasIcsString(generateIcsString({ event, status: "CONFIRMED" }));
    const firstUid = getEventProperty(first, "uid").value;
    const secondUid = getEventProperty(second, "uid").value;
    expect(firstUid).toEqual(expect.any(String));
    expect(secondUid).toEqual(expect.any(String));
    expect(firstUid).toBeTruthy();
    expect(secondUid).toBeTruthy();
    expect(secondUid).not.toBe(firstUid);
  });

  test("preserves participant names, addresses and response fields through quoted parameters", () => {
    const organizer = buildPerson({ name: "Organizer, Café; Team", email: "organizer@example.com" });
    const attendee = buildPerson({ name: "Attendee, North; Team", email: "attendee@example.com" });
    const event = buildCalendarEvent({ organizer, attendees: [attendee], iCalSequence: 3 });
    const value = assertHasIcsString(
      generateIcsString({ event, status: "CONFIRMED", partstat: "TENTATIVE" })
    );
    testIcsStringContains({ icsString: value, event, status: "CONFIRMED" });
    const participant = getEventProperty(value, "attendee");
    const address = z.string().parse(participant.value);
    expect(participant.parameters.cn).toBe(attendee.name);
    expect(address.replace(/^mailto:/i, "")).toBe(attendee.email);
    expect(participant.parameters.role).toBe("REQ-PARTICIPANT");
    expect(participant.parameters.partstat).toBe("TENTATIVE");
    expect(participant.parameters.rsvp).toBe("TRUE");
    expect(getEventProperty(value, "sequence").value).toBe(3);
  });

  describe("booking actions", () => {
    test("when bookingAction is Create", () => {
      const event = buildCalendarEvent({
        iCalSequence: 0,
        attendees: [buildPerson()],
      });

      const status = "CONFIRMED";

      const icsString = generateIcsString({
        event: event,
        status,
      });

      const assertedIcsString = assertHasIcsString(icsString);

      testIcsStringContains({ icsString: assertedIcsString, event, status });
    });
    test("when bookingAction is Cancel", () => {
      const event = buildCalendarEvent({
        iCalSequence: 0,
        attendees: [buildPerson()],
      });
      const status = "CANCELLED";

      const icsString = generateIcsString({
        event: event,
        status,
      });

      const assertedIcsString = assertHasIcsString(icsString);

      testIcsStringContains({ icsString: assertedIcsString, event, status });
    });
    test("when bookingAction is Reschedule", () => {
      const event = buildCalendarEvent({
        iCalSequence: 0,
        attendees: [buildPerson()],
      });
      const status = "CONFIRMED";

      const icsString = generateIcsString({
        event: event,
        status,
      });

      const assertedIcsString = assertHasIcsString(icsString);

      testIcsStringContains({ icsString: assertedIcsString, event, status });
    });
    test("when bookingAction is RequestReschedule", () => {
      const event = buildCalendarEvent({
        iCalSequence: 0,
        attendees: [buildPerson()],
      });
      const status = "CANCELLED";

      const icsString = generateIcsString({
        event: event,
        status,
      });

      const assertedIcsString = assertHasIcsString(icsString);

      testIcsStringContains({ icsString: assertedIcsString, event, status });
    });
  });
  describe("set location", () => {
    test("Location is a video link", () => {
      const videoCallData = buildVideoCallData();
      const event = buildCalendarEvent(
        {
          iCalSequence: 0,
          attendees: [buildPerson()],
          videoCallData,
        },
        true
      );
      const status = "CANCELLED";

      const icsString = generateIcsString({
        event: event,
        status,
      });

      assertHasIcsString(icsString);

      expect(icsString).toEqual(expect.stringContaining(`LOCATION:${videoCallData.url}`));
    });
    // Could be custom link, address, or phone number
    test("Location is a string", () => {
      const event = buildCalendarEvent(
        {
          iCalSequence: 0,
          attendees: [buildPerson()],
          location: "+1234567890",
        },
        true
      );
      const status = "CANCELLED";

      const icsString = generateIcsString({
        event: event,
        status,
      });

      assertHasIcsString(icsString);

      expect(icsString).toEqual(expect.stringContaining(`LOCATION:${event.location}`));
    });
  });
  describe("error handling", () => {
    test("throws ErrorWithCode.BadRequest when ics library returns ValidationError", async () => {
      // Mock the ics library to return a ValidationError
      const ics = await import("ics");
      const createEventSpy = vi.spyOn(ics, "createEvent");

      // Simulate a Yup ValidationError (which has name: "ValidationError")
      const validationError = {
        name: "ValidationError",
        message: "attendees[0].email must be a valid email",
        errors: ["attendees[0].email must be a valid email"],
      };

      createEventSpy.mockReturnValueOnce({
        error: validationError as unknown as Error,
        value: null,
      });

      const event = buildCalendarEvent({
        iCalSequence: 0,
        attendees: [buildPerson()],
      });

      expect(() =>
        generateIcsString({
          event,
          status: "CONFIRMED",
        })
      ).toThrow(ErrorWithCode);

      try {
        generateIcsString({
          event,
          status: "CONFIRMED",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ErrorWithCode);
        expect((error as ErrorWithCode).code).toBe(ErrorCode.BadRequest);
        expect((error as ErrorWithCode).message).toBe("attendees[0].email must be a valid email");
      }

      createEventSpy.mockRestore();
    });

    test("re-throws non-ValidationError errors as-is", async () => {
      const ics = await import("ics");
      const createEventSpy = vi.spyOn(ics, "createEvent");

      // Simulate a different type of error
      const genericError = new Error("Some other error");

      createEventSpy.mockReturnValueOnce({
        error: genericError,
        value: null,
      });

      const event = buildCalendarEvent({
        iCalSequence: 0,
        attendees: [buildPerson()],
      });

      expect(() =>
        generateIcsString({
          event,
          status: "CONFIRMED",
        })
      ).toThrow(genericError);

      createEventSpy.mockRestore();
    });

    test("returns ics string when there is no error", () => {
      const event = buildCalendarEvent({
        iCalSequence: 0,
        attendees: [buildPerson()],
      });

      const icsString = generateIcsString({
        event,
        status: "CONFIRMED",
      });

      expect(icsString).toBeDefined();
      expect(typeof icsString).toBe("string");
    });
  });
});
