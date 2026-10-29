import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarExport } from "../src/client/calendar-export.ts";

const booking = {
  id: "a".repeat(64),
  version: 1,
  title: "\uFEFFStored title &text=Injected?subject=evil#fragment + café",
  start: Date.parse("2030-01-10T09:00:00Z"),
  end: Date.parse("2030-01-10T09:30:00Z"),
};
const exportedAt = Date.parse("2030-01-09T12:00:00Z");
const calendar = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
const unfold = (value: string) => value.replace(/\r\n /g, "");

test("composers escape literal titles and export only canonical UTC facts", () => {
  const privateBooking = {
    ...booking,
    name: "Private Attendee",
    email: "private@example.test",
    manageToken: "secret-token",
    notes: "secret-notes",
    guests: ["guest-secret@example.test"],
    credential: { key: "provider-secret" },
    url: "https://private.invalid/booking#secret-token",
  };
  const links = calendarExport(privateBooking, exportedAt);
  const google = new URL(links.google);
  assert.equal(google.origin + google.pathname, "https://calendar.google.com/calendar/r/eventedit");
  assert.deepEqual(Object.fromEntries(google.searchParams), {
    dates: "20300110T090000Z/20300110T093000Z",
    text: booking.title,
  });
  for (const [link, host] of [
    [links.outlook, "outlook.live.com"],
    [links.office, "outlook.office.com"],
  ]) {
    const url = new URL(link);
    assert.equal(url.origin + url.pathname, `https://${host}/calendar/0/deeplink/compose`);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      path: "/calendar/action/compose",
      rru: "addevent",
      startdt: "2030-01-10T09:00:00.000Z",
      enddt: "2030-01-10T09:30:00.000Z",
      subject: booking.title,
    });
  }
  for (const value of Object.values(links))
    assert.doesNotMatch(
      decodeURIComponent(value),
      /secret|private@example|Private Attendee|private\.invalid/
    );
  assert.equal(links.filename, "booking.ics");
});

test("ICS escapes text, folds UTF-8 at 75 octets and cannot inject event properties", () => {
  const title = `Comma,semicolon;backslash\\\r\nATTENDEE:evil\n${"界😀é".repeat(40)}\ud800\u0000`;
  const links = calendarExport({ ...booking, title }, exportedAt);
  assert.ok(links.ics.startsWith("data:text/calendar;charset=utf-8,"));
  const ics = calendar(links.ics);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n"));
  assert.equal(ics.replaceAll("\r\n", "").includes("\n"), false);
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
    assert.equal(Buffer.from(line).toString("utf8"), line);
  }
  const text = unfold(ics);
  assert.ok(
    text.includes(`SUMMARY:Comma\\,semicolon\\;backslash\\\\\\nATTENDEE:evil\\n${"界😀é".repeat(40)}��\r\n`)
  );
  assert.doesNotMatch(text, /\r\n(?:ATTENDEE|ORGANIZER|METHOD|DESCRIPTION|LOCATION|URL):/);
  for (const property of [
    "BEGIN:VEVENT",
    "DTSTART:20300110T090000Z",
    "DTEND:20300110T093000Z",
    "DTSTAMP:20300109T120000Z",
    "SEQUENCE:1",
  ])
    assert.ok(text.split("\r\n").includes(property));
});

test("midnight and DST intervals retain literal instants and stable identity after rescheduling", () => {
  const original = unfold(calendar(calendarExport(booking, exportedAt).ics));
  assert.ok(original.split("\r\n").includes(`UID:${"a".repeat(64)}@calflare.invalid`));
  for (const [start, end, compact] of [
    ["2030-01-10T23:45:00Z", "2030-01-11T00:15:00Z", "20300110T234500Z/20300111T001500Z"],
    ["2030-03-10T01:45:00-05:00", "2030-03-10T03:15:00-04:00", "20300310T064500Z/20300310T071500Z"],
    ["2030-11-03T01:45:00-04:00", "2030-11-03T01:15:00-05:00", "20301103T054500Z/20301103T061500Z"],
  ]) {
    const moved = { ...booking, version: 2, start: Date.parse(start), end: Date.parse(end) };
    const links = calendarExport(moved, exportedAt + 1000);
    assert.equal(new URL(links.google).searchParams.get("dates"), compact);
    const text = unfold(calendar(links.ics));
    assert.equal(text.match(/^UID:.+$/m)?.[0], original.match(/^UID:.+$/m)?.[0]);
    assert.ok(text.includes("\r\nSEQUENCE:2\r\n"));
    const [from, to] = compact.split("/");
    assert.ok(text.includes(`\r\nDTSTART:${from}\r\nDTEND:${to}\r\n`));
    for (const timeZone of ["UTC", "Asia/Kolkata", "America/New_York"])
      for (const timeFormat of ["HH:mm", "h:mma"])
        assert.deepEqual(
          calendarExport({ ...moved, ...{ timeZone, timeFormat } }, exportedAt),
          calendarExport(moved, exportedAt)
        );
  }
});
