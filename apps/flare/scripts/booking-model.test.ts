import assert from "node:assert/strict";
import { test } from "node:test";
import type { BookingSnapshot } from "../src/server/booking-model.ts";
import { matches, parseChange, parseCreate, snapshot, timestamp } from "../src/server/booking-model.ts";
import type { CalendarEvent } from "../src/server/google.ts";
import { ErrorWithCode } from "../src/server/http.ts";

const start = Date.parse("2026-01-05T09:00:00Z");
const create = {
  requestKey: "create-request-0001",
  start,
  name: "Guest",
  email: "guest@example.com",
  timeZone: "Asia/Manila",
};
const desired: BookingSnapshot = {
  id: "a".repeat(64),
  start,
  end: start + 30 * 60_000,
  timeZone: create.timeZone,
  title: "Consultation",
  description: "",
  attendee: { name: create.name, email: create.email },
  privateMetadata: { application: "calflare", booking: "a".repeat(64), operation: "first" },
};
const remote: CalendarEvent = {
  id: desired.id,
  etag: '"first"',
  start: { dateTime: "2026-01-05T17:00:00+08:00" },
  end: { dateTime: "2026-01-05T17:30:00+08:00" },
  summary: desired.title,
  attendees: [{ email: create.email, displayName: create.name }],
  extendedProperties: { private: { ...desired.privateMetadata } },
};

test("booking requests produce stable replay payloads regardless of property order", () => {
  const input = Object.freeze({ ...create });
  assert.deepEqual(parseCreate(input), { action: "create", ...create });
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(JSON.stringify(parseCreate(input)), JSON.stringify(parseCreate(reversed)));
  const move = { action: "reschedule", requestKey: "move-request-00001", version: 1, start };
  assert.deepEqual(parseChange(move), move);
  assert.equal(
    JSON.stringify(parseChange(move)),
    JSON.stringify(parseChange(Object.fromEntries(Object.entries(move).reverse())))
  );
  assert.deepEqual(parseChange({ action: "cancel", requestKey: move.requestKey, version: 2 }), {
    action: "cancel",
    requestKey: move.requestKey,
    version: 2,
  });
});

test("booking request boundaries reject malformed fields and unsupported commands", () => {
  for (const input of [null, [], "", { ...create, extra: true }]) assert.throws(() => parseCreate(input));
  for (const change of [
    { requestKey: "short" },
    { requestKey: "x".repeat(129) },
    { requestKey: "invalid key here!" },
    { start: Number.NaN },
    { start: start + 0.5 },
    { start: "2026-01-05T09:00:00Z" },
    { name: " " },
    { name: "x".repeat(201) },
    { email: "guest@" },
    { email: "x".repeat(243) + "@example.com" },
    { timeZone: "Invalid/Zone" },
    { timeZone: "" },
  ])
    assert.throws(() => parseCreate({ ...create, ...change }), JSON.stringify(change));
  const move = { action: "reschedule", requestKey: "move-request-00001", version: 1, start };
  for (const change of [
    { action: "delete" },
    { action: "create" },
    { version: 0 },
    { version: 1.5 },
    { start: undefined },
    { requestKey: "short" },
    { extra: true },
  ])
    assert.throws(() => parseChange({ ...move, ...change }), JSON.stringify(change));
  assert.throws(() => parseChange({ ...move, action: "cancel" }));
  assert.equal(timestamp(Date.UTC(2000, 0, 1)), Date.UTC(2000, 0, 1));
  assert.equal(timestamp(Date.UTC(2100, 0, 1)), Date.UTC(2100, 0, 1));
  for (const time of [Date.UTC(2000, 0, 1) - 1, Date.UTC(2100, 0, 1) + 1])
    assert.throws(() => timestamp(time));
});

test("cancellation reasons normalize without changing legacy command bytes", () => {
  const cancel = { action: "cancel", requestKey: "cancel-request-0001", version: 2 };
  const legacy = '{"action":"cancel","requestKey":"cancel-request-0001","version":2}';
  for (const extra of [{}, { cancellationReason: "" }, { cancellationReason: " \t\r\n " }])
    assert.equal(JSON.stringify(parseChange({ ...cancel, ...extra })), legacy);
  for (const reason of [
    "Need to cancel",
    "First\n\nSecond\r\n é 😀 <literal>",
    "x".repeat(1000),
    "😀".repeat(500),
    "\u0000".repeat(1000),
  ])
    assert.equal(
      JSON.stringify(parseChange({ cancellationReason: ` \n${reason}\t `, ...cancel })),
      `${legacy.slice(0, -1)},"cancellationReason":${JSON.stringify(reason)}}`
    );
  for (const cancellationReason of [null, 1, false, [], {}, "x".repeat(1001), `${"😀".repeat(500)}x`])
    assert.throws(() => parseChange({ ...cancel, cancellationReason }), ErrorWithCode);
  for (const cancellationReason of ["", " ", "reason", undefined])
    assert.throws(() => parseChange({ ...cancel, action: "reschedule", start, cancellationReason }));
  assert.equal(
    JSON.stringify(parseChange({ ...cancel, action: "reschedule", start })),
    `{"action":"reschedule","requestKey":"cancel-request-0001","version":2,"start":${start}}`
  );
  assert.throws(() => parseChange({ ...cancel, cancellationReason: "reason", extra: true }));
});

test("optional notes preserve legacy bytes and canonical literal content within 1000 UTF-16 units", () => {
  const legacy = `{"action":"create","requestKey":"create-request-0001","start":${start},"name":"Guest","email":"guest@example.com","timeZone":"Asia/Manila"}`;
  assert.equal(JSON.stringify(parseCreate(create)), legacy);
  for (const notes of ["", " \t\r\n "])
    assert.equal(JSON.stringify(parseCreate({ ...create, notes })), legacy);
  const notes = "First line\n\nSecond line <plain> & text\r\nThird line  é 😀";
  const input = { notes: ` \n${notes}\t `, ...create };
  assert.equal(
    JSON.stringify(parseCreate(input)),
    `${legacy.slice(0, -1)},"notes":${JSON.stringify(notes)}}`
  );
  assert.equal(parseCreate({ ...create, notes: ` ${"😀".repeat(500)} ` }).notes, "😀".repeat(500));
  assert.equal(parseCreate({ ...create, notes: "x".repeat(1000) }).notes?.length, 1000);
  for (const notes of [null, 1, false, [], {}, "x".repeat(1001), `${"😀".repeat(500)}x`])
    assert.throws(
      () => parseCreate({ ...create, notes }),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_input"
    );
  assert.throws(() => parseCreate({ ...create, notes, extra: true }), ErrorWithCode);
});

test("reschedule reasons preserve legacy bytes and enforce strict normalized literal content", () => {
  const move = { action: "reschedule", requestKey: "move-request-00001", version: 1, start };
  const legacy = `{"action":"reschedule","requestKey":"move-request-00001","version":1,"start":${start}}`;
  for (const extra of [
    {},
    { rescheduleReason: undefined },
    { rescheduleReason: "" },
    { rescheduleReason: " \t\r\n " },
  ])
    assert.equal(JSON.stringify(parseChange({ ...move, ...extra })), legacy);
  for (const reason of [
    "Need to move",
    "First\r\n\n é 😀 <literal>",
    "x".repeat(1000),
    "😀".repeat(500),
    "\u0000".repeat(1000),
  ]) {
    const input = { rescheduleReason: ` \n${reason}\t `, ...move };
    const expected = `${legacy.slice(0, -1)},"rescheduleReason":${JSON.stringify(reason)}}`;
    assert.equal(JSON.stringify(parseChange(input)), expected);
    assert.equal(JSON.stringify(parseChange(Object.fromEntries(Object.entries(input).reverse()))), expected);
  }
  for (const rescheduleReason of [null, 1, false, [], {}, "x".repeat(1001), `${"😀".repeat(500)}x`])
    assert.throws(() => parseChange({ ...move, rescheduleReason }), ErrorWithCode);
  for (const rescheduleReason of [undefined, "", " ", "reason"])
    assert.throws(() =>
      parseChange({ action: "cancel", requestKey: move.requestKey, version: 1, rescheduleReason })
    );
  assert.throws(() => parseChange({ ...move, rescheduleReason: "reason", extra: true }));
});

test("guests preserve ordered identity, strict native email rules and legacy bytes", () => {
  const legacy = JSON.stringify(parseCreate({ ...create, notes: "Note" }));
  for (const guests of [[], ["", ""]]) {
    assert.equal(JSON.stringify(parseCreate({ ...create, notes: "Note", guests })), legacy);
    assert.deepEqual(snapshot(JSON.stringify({ ...desired, guests })), desired);
  }
  const guests = ["Z@example.com", "a+tag@example.com", create.email];
  const parsed = parseCreate({ ...create, notes: "Note", guests });
  assert.deepEqual(parsed.guests, ["z@example.com", "a+tag@example.com", create.email]);
  assert.equal(JSON.stringify(parsed), `${legacy.slice(0, -1)},"guests":${JSON.stringify(parsed.guests)}}`);
  assert.ok(Object.isFrozen(parsed.guests));
  assert.deepEqual(parseCreate({ ...create, guests: ["a_b+'c,d.e-f@example.com"] }).guests, [
    "a_b+'c,d.e-f@example.com",
  ]);
  guests[0] = "changed@example.com";
  assert.equal(parsed.guests?.[0], "z@example.com");
  assert.equal(
    parseCreate({ ...create, guests: [`${"a".repeat(242)}@example.com`] }).guests?.[0]?.length,
    254
  );
  assert.equal(
    parseCreate({ ...create, guests: Array.from({ length: 21 }, (_, i) => `g${i}@example.com`) }).guests
      ?.length,
    21
  );
  for (const guests of [
    null,
    "a@example.com",
    {},
    [1],
    [undefined],
    Array(2),
    [null],
    ["", "a@example.com"],
    [" "],
    [" a@example.com"],
    ["a@example.com\n"],
    [".a@example.com"],
    ["a..b@example.com"],
    ["a@b.c"],
    ["é@example.com"],
    [`${"a".repeat(243)}@example.com`],
    ["A@example.com", "a@example.com"],
  ]) {
    assert.throws(() => parseCreate({ ...create, guests }), ErrorWithCode);
    assert.throws(() => snapshot(JSON.stringify({ ...desired, guests })), ErrorWithCode);
  }
  const saved = snapshot(JSON.stringify({ ...desired, guests: ["Z@example.com", create.email] }));
  assert.deepEqual(saved.guests, ["z@example.com", create.email]);
  assert.ok(Object.isFrozen(saved.guests));
  assert.throws(() =>
    parseChange({ action: "cancel", requestKey: create.requestKey, version: 1, guests: [] })
  );
});

test("persisted snapshots retain validated booking content and reject corrupt state", () => {
  assert.deepEqual(snapshot(JSON.stringify(desired)), desired);
  for (const change of [
    { end: start },
    { end: start - 1 },
    { start: null },
    { description: null },
    { timeZone: "Invalid/Zone" },
    { attendee: { name: "Guest", email: "bad" } },
    { privateMetadata: { booking: 3 } },
    { title: " " },
  ])
    assert.throws(() => snapshot(JSON.stringify({ ...desired, ...change })));
  assert.throws(() => snapshot("not json"));
  assert.throws(() => snapshot("[]"));
  const data = { ...desired, privateMetadata: JSON.parse('{"__proto__":"kept as data"}') };
  const parsed = snapshot(JSON.stringify(data));
  assert.equal(Object.hasOwn(parsed.privateMetadata, "__proto__"), true);
  assert.equal(parsed.privateMetadata.__proto__, "kept as data");
});

test("calendar reconciliation tolerates RSVP and ETag changes while protecting booking content", () => {
  assert.equal(matches(remote, desired), true);
  const rsvp = structuredClone(remote);
  rsvp.etag = '"changed"';
  rsvp.attendees[0] = { email: "GUEST@example.com", displayName: create.name, responseStatus: "accepted" };
  assert.equal(matches(rsvp, desired), true);
  for (const change of [
    { id: "other" },
    { status: "cancelled" },
    { summary: "Changed" },
    { description: "Changed" },
    { start: { date: "2026-01-05" } },
    { end: { dateTime: "2026-01-05T10:00:00Z" } },
    { attendees: [] },
    { attendees: [{ email: create.email, displayName: "Other" }] },
    { attendees: [{ email: "other@example.com", displayName: create.name }] },
    { extendedProperties: { private: { ...desired.privateMetadata, operation: "other" } } },
  ])
    assert.equal(matches({ ...remote, ...change }, desired), false, JSON.stringify(change));
  assert.equal(matches(remote, desired), true);
});

test("reconciliation proves the entire recipient set with only a trusted owner exception", () => {
  const expected = { ...desired, guests: ["z@example.com", "a@example.com", create.email] };
  const attendees = [
    { email: "A@example.com", displayName: "Any guest name", responseStatus: "declined" },
    ...remote.attendees,
    { email: "z@example.com", displayName: "" },
    { email: "a@example.com" },
  ];
  assert.equal(matches({ ...remote, attendees }, expected), true);
  for (const changed of [
    attendees.slice(0, 2),
    [...attendees, { email: "extra@example.com", self: true, organizer: true }],
    attendees.map((row) => (row.email === "z@example.com" ? { email: "substitute@example.com" } : row)),
  ])
    assert.equal(matches({ ...remote, attendees: changed }, expected), false);
  const owner = { email: "OWNER@example.com", self: true };
  assert.equal(matches({ ...remote, attendees: [...attendees, owner] }, expected), false);
  assert.equal(
    matches(
      { ...remote, attendees: [...attendees, owner], calendarOwnerEmail: "owner@example.com" },
      expected
    ),
    true
  );
  assert.equal(matches({ ...remote, attendees: [...remote.attendees, owner] }, desired), false);
  assert.equal(
    matches({ ...remote, attendees: [...remote.attendees, owner], calendarOwnerEmail: owner.email }, desired),
    true
  );
  assert.equal(
    matches({ ...remote, attendees: [{ email: owner.email }], calendarOwnerEmail: owner.email }, desired),
    false
  );
  for (const partial of [
    { attendeesOmitted: true },
    { attendees: [{ ...remote.attendees[0], email: create.email, additionalGuests: 1 }] },
  ])
    assert.equal(matches({ ...remote, ...partial }, desired), false);
});
