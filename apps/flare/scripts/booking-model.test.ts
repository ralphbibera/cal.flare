import assert from "node:assert/strict";
import { test } from "node:test";
import type { BookingSnapshot } from "../src/server/booking-model.ts";
import { matches, parseChange, parseCreate, snapshot, timestamp } from "../src/server/booking-model.ts";
import type { CalendarEvent } from "../src/server/google.ts";

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
