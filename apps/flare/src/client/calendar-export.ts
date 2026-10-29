import type { BookingView } from "../server/booking-model.ts";

type CalendarBooking = Pick<BookingView, "id" | "title" | "start" | "end" | "version">;
const encoder = new TextEncoder();
const utc = (instant: number) => new Date(instant).toISOString().replace(/[-:]|\.\d{3}/g, "");

function foldLine(line: string): string {
  const segments: string[] = [];
  let segment = "";
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > (segments.length === 0 ? 75 : 74)) {
      segments.push(segment);
      segment = "";
      bytes = 0;
    }
    segment += character;
    bytes += size;
  }
  segments.push(segment);
  return segments.join("\r\n ");
}

export function calendarExport(booking: CalendarBooking, exportedAt: number) {
  const title = new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(encoder.encode(booking.title))
    .replace(/\p{Cc}/gu, (character) => (["\r", "\n", "\t"].includes(character) ? character : "\uFFFD"));
  const summary = title
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[,;]/g, "\\$&");
  const calendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cal.flare//Booking export//EN",
    "BEGIN:VEVENT",
    `UID:${booking.id}@calflare.invalid`,
    `SEQUENCE:${booking.version}`,
    `DTSTAMP:${utc(exportedAt)}`,
    `DTSTART:${utc(booking.start)}`,
    `DTEND:${utc(booking.end)}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .map(foldLine)
    .join("\r\n");
  const microsoft = (host: string) =>
    `https://${host}/calendar/0/deeplink/compose?${new URLSearchParams({
      path: "/calendar/action/compose",
      rru: "addevent",
      startdt: new Date(booking.start).toISOString(),
      enddt: new Date(booking.end).toISOString(),
      subject: title,
    })}`;
  return {
    google: `https://calendar.google.com/calendar/r/eventedit?${new URLSearchParams({
      dates: `${utc(booking.start)}/${utc(booking.end)}`,
      text: title,
    })}`,
    outlook: microsoft("outlook.live.com"),
    office: microsoft("outlook.office.com"),
    ics: `data:text/calendar;charset=utf-8,${encodeURIComponent(calendar)}`,
    filename: "booking.ics",
  };
}
