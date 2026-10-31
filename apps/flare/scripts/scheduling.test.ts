import assert from "node:assert/strict";
import test from "node:test";
import type { AvailabilityInput, Interval, SlotPolicy } from "../src/domain/scheduling.ts";
import { availableSlots, isValidTimeZone, overlaps } from "../src/domain/scheduling.ts";

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

// Keep the original per-minute Intl scan independent of offset interpolation.
function scannedWorkingMinutes(value: AvailabilityInput): Interval[] {
  const { schedule, from, to } = value;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const first = Math.ceil(from / 60_000) * 60_000;
  const count = Math.max(0, Math.floor((to - first) / 60_000));
  const slots: Interval[] = [];
  for (let index = 0; index < count; index++) {
    const fields = Object.fromEntries(
      formatter.formatToParts(first + index * 60_000).map((part) => [part.type, part.value])
    );
    const date = `${fields.year}-${fields.month}-${fields.day}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const ranges =
      schedule.overrides?.find((item) => item.date === date)?.ranges ??
      schedule.rules.filter((rule) => rule.weekday === weekday);
    const minute = Number(fields.hour) * 60 + Number(fields.minute);
    if (ranges.some((range) => range.startMinute <= minute && minute < range.endMinute)) {
      const start = first + index * 60_000;
      slots.push({ start, end: start + 60_000 });
    }
  }
  return slots;
}

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

test("invalid and unbounded domain inputs fail before generating slots", () => {
  const value = input();
  const invalid: AvailabilityInput[] = [
    { ...value, to: value.from },
    { ...value, to: value.from + 63 * 86400000 + 1 },
    { ...value, from: Number.NaN },
    { ...value, now: Number.POSITIVE_INFINITY },
    { ...value, visitorTimeZone: "Mars/Olympus" },
    { ...value, from: at("1999-12-31T23:59Z"), to: at("2000-01-01T00:01Z") },
    { ...value, from: at("2099-12-31T23:59Z"), to: at("2100-01-01T00:01Z") },
    { ...value, now: at("1999-12-31T23:59Z") },
    { ...value, now: at("2100-01-01T00:01Z") },
    { ...value, policy: { ...policy, intervalMinutes: 0 } },
    { ...value, policy: { ...policy, durationMinutes: 1.5 } },
    { ...value, policy: { ...policy, beforeMinutes: -1 } },
    { ...value, policy: { ...policy, noticeMinutes: 44641 } },
    { ...value, schedule: { timeZone: "Mars/Olympus", rules: [] } },
    { ...value, schedule: { timeZone: "UTC", rules: [{ weekday: 7, startMinute: 0, endMinute: 60 }] } },
    { ...value, schedule: { timeZone: "UTC", rules: [{ weekday: 1, startMinute: 60, endMinute: 60 }] } },
    { ...value, schedule: { ...value.schedule, overrides: [{ date: "2026-02-30", ranges: [] }] } },
    {
      ...value,
      schedule: {
        ...value.schedule,
        overrides: [
          { date: "2026-01-05", ranges: [] },
          { date: "2026-01-05", ranges: [] },
        ],
      },
    },
    { ...value, busy: [{ start: value.from, end: value.from }] },
    { ...value, busy: Array.from({ length: 10001 }, () => ({ start: value.from, end: value.to })) },
  ];
  for (const invalidInput of invalid) assert.throws(() => availableSlots(invalidInput), RangeError);
  assert.equal(isValidTimeZone("Asia/Kolkata"), true);
  assert.equal(isValidTimeZone("+05:30"), false);
});

test("policy validation preserves the first error when multiple settings are invalid", () => {
  const cases: [Partial<SlotPolicy>, string][] = [
    [{ durationMinutes: 0, intervalMinutes: 0 }, "durationMinutes must be an integer between 1 and 1440"],
    [{ intervalMinutes: 0, bookingWindowDays: 0 }, "intervalMinutes must be an integer between 1 and 1440"],
    [{ bookingWindowDays: 0, beforeMinutes: -1 }, "bookingWindowDays must be an integer between 1 and 365"],
    [
      { beforeMinutes: -1, afterMinutes: -1 },
      "buffer or notice minutes must be an integer between 0 and 44640",
    ],
    [
      { afterMinutes: -1, noticeMinutes: -1 },
      "buffer or notice minutes must be an integer between 0 and 44640",
    ],
    [{ noticeMinutes: 44641 }, "buffer or notice minutes must be an integer between 0 and 44640"],
  ];
  for (const [changes, message] of cases) {
    assert.throws(() => availableSlots(input({ policy: { ...policy, ...changes } })), {
      name: "RangeError",
      message,
    });
  }
});

test("query errors precede policy and schedule errors", () => {
  const value = input({ policy: { ...policy, durationMinutes: 0 }, busy: [{ start: 0, end: 0 }] });
  const cases: [Partial<AvailabilityInput>, string][] = [
    [{ schedule: { timeZone: "invalid", rules: [] }, visitorTimeZone: "invalid" }, "Invalid IANA time zone"],
    [{ visitorTimeZone: "invalid", windowTimeZone: "invalid" }, "Invalid visitor time zone"],
    [{ windowTimeZone: "invalid", from: Number.NaN }, "Invalid window time zone"],
    [
      { from: Number.NaN, to: value.from },
      "timestamp must be an integer between 946684800000 and 4102444800000",
    ],
    [{ to: value.from }, "Query must span (0, 63] days"],
    [{ to: value.from + 63 * 86_400_000 + 1 }, "Query must span (0, 63] days"],
  ];
  for (const [changes, message] of cases) {
    assert.throws(() => availableSlots({ ...value, ...changes }), { name: "RangeError", message });
  }
});

test("schedule validation precedes busy checks and preserves override date and range errors", () => {
  const value = input({ busy: [{ start: 0, end: 0 }] });
  const invalidOverride = { date: "2026-02-30", ranges: [] };
  const cases: [Partial<AvailabilityInput>, string][] = [
    [
      { schedule: { ...value.schedule, rules: Array(101).fill(value.schedule.rules[0]) } },
      "Too many rules, overrides, or busy intervals",
    ],
    [
      {
        schedule: {
          ...value.schedule,
          rules: [{ weekday: 7, startMinute: -1, endMinute: 0 }],
          overrides: [invalidOverride],
        },
      },
      "weekday must be an integer between 0 and 6",
    ],
    [
      { schedule: { ...value.schedule, rules: [{ weekday: 1, startMinute: -1, endMinute: 0 }] } },
      "startMinute must be an integer between 0 and 1439",
    ],
    [
      { schedule: { ...value.schedule, overrides: [invalidOverride] } },
      "Overrides require unique valid YYYY-MM-DD dates and at most 100 ranges",
    ],
    [
      {
        schedule: {
          ...value.schedule,
          overrides: [{ date: "2026-01-05", ranges: [{ startMinute: 60, endMinute: 60 }] }],
        },
      },
      "endMinute must be an integer between 61 and 1440",
    ],
    [{}, "busy start must be an integer between 946684800000 and 4102444800000"],
    [
      { busy: [{ start: value.from, end: Number.NaN }] },
      "busy end must be an integer between 946684800000 and 4102444800000",
    ],
    [{ busy: [{ start: value.from, end: value.from }] }, "Busy intervals must have positive duration"],
  ];
  for (const [changes, message] of cases) {
    assert.throws(() => availableSlots({ ...value, ...changes }), { name: "RangeError", message });
  }
});

test("invalid override collections preserve native iteration errors", () => {
  const cases: [unknown, string][] = [
    [{}, "object"],
    [0, "number 0"],
    [true, "boolean true"],
  ];
  for (const [overrides, prefix] of cases) {
    const value = input();
    Object.defineProperty(value.schedule, "overrides", { value: overrides });
    assert.throws(() => availableSlots(value), {
      name: "TypeError",
      message: `${prefix} is not iterable (cannot read property Symbol(Symbol.iterator))`,
    });
  }
});

test("a 31-day query retains pinned seven-minute spacing from each free-range start", () => {
  assert.deepEqual(
    starts(
      input({
        schedule: { timeZone: "UTC", rules: [{ weekday: 1, startMinute: 540, endMinute: 550 }] },
        policy: { ...policy, intervalMinutes: 7, durationMinutes: 3 },
        to: at("2026-02-05T00:00Z"),
      })
    ),
    [
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T09:07:00.000Z",
      "2026-01-12T09:00:00.000Z",
      "2026-01-12T09:07:00.000Z",
      "2026-01-19T09:00:00.000Z",
      "2026-01-19T09:07:00.000Z",
      "2026-01-26T09:00:00.000Z",
      "2026-01-26T09:07:00.000Z",
      "2026-02-02T09:00:00.000Z",
      "2026-02-02T09:07:00.000Z",
    ]
  );
});

test("hourly offset interpolation matches the minute-scan oracle across fractional zones and transitions", () => {
  const cases = [
    ["America/New_York", "2026-03-07"],
    ["America/New_York", "2026-10-31"],
    ["Australia/Lord_Howe", "2026-04-04"],
    ["Australia/Lord_Howe", "2026-10-03"],
    ["Pacific/Chatham", "2026-04-04"],
    ["Pacific/Chatham", "2026-09-26"],
    ["Asia/Kathmandu", "2026-01-05"],
    ["Asia/Kolkata", "2026-01-05"],
    ["Australia/Eucla", "2026-01-05"],
    ["America/St_Johns", "2026-03-07"],
    ["Africa/Casablanca", "2026-02-14"],
    ["Africa/Casablanca", "2026-03-21"],
    ["Antarctica/Troll", "2026-03-28"],
    ["Antarctica/Troll", "2026-10-24"],
    ["Pacific/Apia", "2011-12-29"],
    ["America/Sao_Paulo", "2018-11-03"],
  ];
  for (const [timeZone, date] of cases) {
    const from = at(`${date}T00:17:00Z`) + 1;
    const value = input({
      schedule: {
        timeZone,
        rules: Array.from({ length: 7 }, (_, weekday) => [
          { weekday, startMinute: 0, endMinute: 127 },
          { weekday, startMinute: 130, endMinute: 1440 },
        ]).flat(),
        overrides: [{ date, ranges: [{ startMinute: 29, endMinute: 1431 }] }],
      },
      from,
      to: from + 3 * 86_400_000 - 2,
      now: from - 60_000,
      policy: {
        durationMinutes: 1,
        intervalMinutes: 1,
        beforeMinutes: 0,
        afterMinutes: 0,
        noticeMinutes: 0,
      },
    });
    assert.deepEqual(availableSlots(value), scannedWorkingMinutes(value), `${timeZone} ${date}`);
  }
});

test("the core retains all 44,640 one-minute slots across a 31-day window", () => {
  const value = input({
    schedule: {
      timeZone: "America/New_York",
      rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
    },
    policy: { ...policy, durationMinutes: 1, intervalMinutes: 1 },
    from: at("2026-03-01T00:00Z"),
    to: at("2026-04-01T00:00Z"),
  });
  const slots = availableSlots(value);
  assert.equal(slots.length, 44_640);
  assert.deepEqual(slots, scannedWorkingMinutes(value));
});

test("two-month prefetch remains bounded and retains every minute and cross-boundary slot", () => {
  const from = at("2026-01-01T00:00Z");
  const value = input({
    schedule: {
      timeZone: "UTC",
      rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
    },
    policy: { ...policy, durationMinutes: 1, intervalMinutes: 1 },
    from,
    to: from + 63 * 86_400_000,
  });
  const slots = availableSlots(value);
  assert.equal(slots.length, 90_720);
  for (let index = 0; index < slots.length; index++) {
    assert.deepEqual(slots[index], { start: from + index * 60_000, end: from + (index + 1) * 60_000 });
  }
  assert.throws(() => availableSlots({ ...value, to: value.to + 1 }), RangeError);
  const spaced = availableSlots({ ...value, policy: { ...policy, durationMinutes: 3, intervalMinutes: 7 } });
  const boundary = from + 31 * 86_400_000;
  assert.ok(spaced.some((slot) => slot.start === boundary - 60_000 && slot.end === boundary + 2 * 60_000));
  assert.ok(spaced.some((slot) => slot.start === boundary + 6 * 60_000));
});
