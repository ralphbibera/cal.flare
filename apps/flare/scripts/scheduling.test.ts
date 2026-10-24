import assert from "node:assert/strict";
import test from "node:test";
import type { AvailabilityInput, SlotPolicy } from "../src/domain/scheduling.ts";
import { availableSlots, overlaps } from "../src/domain/scheduling.ts";

const at = (value: string): number => Date.parse(value);
const policy: SlotPolicy = {
  durationMinutes: 30,
  intervalMinutes: 30,
  beforeMinutes: 0,
  afterMinutes: 0,
  noticeMinutes: 0,
};
const input = (changes: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  schedule: { timeZone: "UTC", rules: [{ weekday: 1, startMinute: 540, endMinute: 660 }] },
  visitorTimeZone: "UTC",
  policy,
  from: at("2026-01-05T00:00:00Z"),
  to: at("2026-01-06T00:00:00Z"),
  now: at("2026-01-01T00:00:00Z"),
  busy: [],
  ...changes,
});
const starts = (value: AvailabilityInput): string[] =>
  availableSlots(value).map((slot) => new Date(slot.start).toISOString());

test("weekly hours return sorted elapsed-duration UTC slots without mutating input", () => {
  const value = input();
  const snapshot = structuredClone(value);
  assert.deepEqual(availableSlots(value), [
    { start: at("2026-01-05T09:00Z"), end: at("2026-01-05T09:30Z") },
    { start: at("2026-01-05T09:30Z"), end: at("2026-01-05T10:00Z") },
    { start: at("2026-01-05T10:00Z"), end: at("2026-01-05T10:30Z") },
    { start: at("2026-01-05T10:30Z"), end: at("2026-01-05T11:00Z") },
  ]);
  assert.deepEqual(value, snapshot);
});

test("pinned 40-minute spacing starts at the free-range boundary", () => {
  assert.deepEqual(starts(input({ policy: { ...policy, intervalMinutes: 40, durationMinutes: 40 } })), [
    "2026-01-05T09:00:00.000Z",
    "2026-01-05T09:40:00.000Z",
    "2026-01-05T10:20:00.000Z",
  ]);
});

test("pinned hourly rounding uses the visitor zone before spacing slots", () => {
  assert.deepEqual(
    starts(input({ visitorTimeZone: "Asia/Kolkata", policy: { ...policy, intervalMinutes: 60 } })),
    ["2026-01-05T09:30:00.000Z", "2026-01-05T10:30:00.000Z"]
  );
});

test("busy subtraction creates a new rounding boundary after the blocked interval", () => {
  assert.deepEqual(
    starts(
      input({
        schedule: { timeZone: "UTC", rules: [{ weekday: 1, startMinute: 540, endMinute: 720 }] },
        policy: { ...policy, intervalMinutes: 40, durationMinutes: 40 },
        busy: [{ start: at("2026-01-05T10:05Z"), end: at("2026-01-05T10:10Z") }],
      })
    ),
    ["2026-01-05T09:00:00.000Z", "2026-01-05T10:20:00.000Z", "2026-01-05T11:00:00.000Z"]
  );
});

test("pinned spacing carries across a short busy interval", () => {
  const value = input({
    policy: { ...policy, durationMinutes: 3, intervalMinutes: 40 },
    busy: [{ start: at("2026-01-05T09:05Z"), end: at("2026-01-05T09:06Z") }],
  });
  assert.deepEqual(starts(value), [
    "2026-01-05T09:00:00.000Z",
    "2026-01-05T09:40:00.000Z",
    "2026-01-05T10:20:00.000Z",
  ]);
});

test("spring-forward skips nonexistent times and measures duration in real minutes", () => {
  const value = input({
    schedule: { timeZone: "America/New_York", rules: [{ weekday: 0, startMinute: 60, endMinute: 240 }] },
    from: at("2026-03-08T05:00Z"),
    to: at("2026-03-08T09:00Z"),
  });
  assert.deepEqual(starts(value), [
    "2026-03-08T06:00:00.000Z",
    "2026-03-08T06:30:00.000Z",
    "2026-03-08T07:00:00.000Z",
    "2026-03-08T07:30:00.000Z",
  ]);
  assert.deepEqual(availableSlots({ ...value, policy: { ...policy, durationMinutes: 60 } })[1], {
    start: at("2026-03-08T06:30Z"),
    end: at("2026-03-08T07:30Z"),
  });
});

test("fall-back returns both occurrences and rejects slots crossing nonworking repeated minutes", () => {
  const value = input({
    schedule: { timeZone: "America/New_York", rules: [{ weekday: 0, startMinute: 60, endMinute: 120 }] },
    from: at("2026-11-01T04:00Z"),
    to: at("2026-11-01T08:00Z"),
  });
  assert.deepEqual(starts(value), [
    "2026-11-01T05:00:00.000Z",
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:00:00.000Z",
    "2026-11-01T06:30:00.000Z",
  ]);
  assert.deepEqual(
    starts({
      ...value,
      schedule: { ...value.schedule, rules: [{ weekday: 0, startMinute: 90, endMinute: 120 }] },
      policy: { ...policy, durationMinutes: 60 },
    }),
    []
  );
});

test("fractional-hour zones use organizer dates and explicit visitor rounding", () => {
  assert.deepEqual(
    starts(
      input({
        schedule: { timeZone: "Asia/Kolkata", rules: [{ weekday: 1, startMinute: 0, endMinute: 60 }] },
        visitorTimeZone: "Asia/Kolkata",
        policy: { ...policy, intervalMinutes: 20, durationMinutes: 20 },
        from: at("2026-01-04T18:00Z"),
        to: at("2026-01-04T20:00Z"),
      })
    ),
    ["2026-01-04T18:30:00.000Z", "2026-01-04T18:50:00.000Z", "2026-01-04T19:10:00.000Z"]
  );
});

test("Lord Howe half-hour DST transition preserves both real occurrences", () => {
  assert.deepEqual(
    starts(
      input({
        schedule: {
          timeZone: "Australia/Lord_Howe",
          rules: [{ weekday: 0, startMinute: 90, endMinute: 120 }],
        },
        from: at("2026-04-04T14:00Z"),
        to: at("2026-04-04T16:00Z"),
      })
    ),
    ["2026-04-04T14:30:00.000Z", "2026-04-04T15:00:00.000Z"]
  );
});

test("date overrides replace weekly hours, close days, and open normally closed days", () => {
  const value = input();
  assert.deepEqual(
    starts({ ...value, schedule: { ...value.schedule, overrides: [{ date: "2026-01-05", ranges: [] }] } }),
    []
  );
  assert.deepEqual(
    starts({
      ...value,
      schedule: {
        ...value.schedule,
        overrides: [
          { date: "2026-01-05", ranges: [{ startMinute: 720, endMinute: 750 }] },
          { date: "2026-01-06", ranges: [{ startMinute: 720, endMinute: 750 }] },
        ],
      },
      to: at("2026-01-07T00:00Z"),
    }),
    ["2026-01-05T12:00:00.000Z", "2026-01-06T12:00:00.000Z"]
  );
});

test("adjacent busy intervals are allowed while any positive overlap is excluded", () => {
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 }), false);
  assert.deepEqual(
    starts(
      input({
        busy: [
          { start: at("2026-01-05T08:30Z"), end: at("2026-01-05T09:00Z") },
          { start: at("2026-01-05T09:30Z"), end: at("2026-01-05T10:00Z") },
        ],
      })
    ),
    ["2026-01-05T09:00:00.000Z", "2026-01-05T10:00:00.000Z", "2026-01-05T10:30:00.000Z"]
  );
});

test("candidate buffers block conflicts outside the query without shrinking working hours", () => {
  const value = input({
    from: at("2026-01-05T09:00Z"),
    to: at("2026-01-05T11:00Z"),
    policy: { ...policy, beforeMinutes: 10, afterMinutes: 10 },
  });
  assert.equal(availableSlots(value).length, 4);
  assert.deepEqual(
    starts({
      ...value,
      busy: [
        { start: at("2026-01-05T08:49Z"), end: at("2026-01-05T08:51Z") },
        { start: at("2026-01-05T11:09Z"), end: at("2026-01-05T11:20Z") },
      ],
    }),
    ["2026-01-05T09:30:00.000Z", "2026-01-05T10:00:00.000Z"]
  );
  assert.equal(
    availableSlots({
      ...value,
      busy: [
        { start: at("2026-01-05T08:00Z"), end: at("2026-01-05T08:50Z") },
        { start: at("2026-01-05T11:10Z"), end: at("2026-01-05T12:00Z") },
      ],
    }).length,
    4
  );
});

test("notice uses the explicit clock and allows its exact boundary", () => {
  const value = input({ now: at("2026-01-05T09:00Z"), policy: { ...policy, noticeMinutes: 30 } });
  assert.equal(starts(value)[0], "2026-01-05T09:30:00.000Z");
  assert.equal(starts({ ...value, now: value.now + 1 })[0], "2026-01-05T10:00:00.000Z");
});

test("before and after buffers apply on their respective sides", () => {
  const value = input({ busy: [{ start: at("2026-01-05T09:40Z"), end: at("2026-01-05T09:50Z") }] });
  assert.deepEqual(starts({ ...value, policy: { ...policy, beforeMinutes: 15 } }), [
    "2026-01-05T09:00:00.000Z",
    "2026-01-05T10:30:00.000Z",
  ]);
  assert.deepEqual(starts({ ...value, policy: { ...policy, afterMinutes: 15 } }), [
    "2026-01-05T10:00:00.000Z",
    "2026-01-05T10:30:00.000Z",
  ]);
});

test("an appointment cannot bridge a nonworking gap", () => {
  assert.deepEqual(
    starts(
      input({
        schedule: {
          timeZone: "UTC",
          rules: [
            { weekday: 1, startMinute: 540, endMinute: 555 },
            { weekday: 1, startMinute: 556, endMinute: 600 },
          ],
        },
      })
    ),
    ["2026-01-05T09:30:00.000Z"]
  );
});

test("slots must wholly fit query and working union, with no duplicate slots", () => {
  const value = input({
    schedule: {
      timeZone: "UTC",
      rules: [
        { weekday: 1, startMinute: 540, endMinute: 555 },
        { weekday: 1, startMinute: 555, endMinute: 600 },
        { weekday: 1, startMinute: 540, endMinute: 570 },
      ],
    },
    from: at("2026-01-05T09:00Z") + 1,
    to: at("2026-01-05T10:00Z") - 1,
  });
  assert.deepEqual(starts(value), []);
  assert.deepEqual(starts({ ...value, from: value.from - 1, to: value.to + 1 }), [
    "2026-01-05T09:00:00.000Z",
    "2026-01-05T09:30:00.000Z",
  ]);
});

test("pinned seven-minute spacing starts at the free range rather than midnight", () => {
  const value = input({
    schedule: { timeZone: "UTC", rules: [{ weekday: 1, startMinute: 540, endMinute: 550 }] },
    policy: { ...policy, intervalMinutes: 7, durationMinutes: 3 },
  });
  assert.deepEqual(starts(value), ["2026-01-05T09:00:00.000Z", "2026-01-05T09:07:00.000Z"]);
});
