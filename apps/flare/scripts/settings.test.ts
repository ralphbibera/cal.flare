import assert from "node:assert/strict";
import { test } from "node:test";
import type { Settings } from "../src/domain/settings.ts";
import { defaultSettings, parseSettings, SettingsError } from "../src/domain/settings.ts";
import { getSettings, saveSettings } from "../src/server/settings.ts";
import { apiFixture } from "./fixtures/api.ts";

function settings(): Settings {
  return structuredClone(defaultSettings);
}

test("default settings provide the intro event and weekday UTC working hours", () => {
  assert.deepEqual(parseSettings(defaultSettings), {
    event: {
      slug: "intro",
      title: "Intro call",
      description: "",
      durationMinutes: 30,
      intervalMinutes: 30,
      beforeMinutes: 0,
      afterMinutes: 0,
      noticeMinutes: 120,
    },
    schedule: {
      timeZone: "UTC",
      rules: [
        { weekday: 1, startMinute: 540, endMinute: 1020 },
        { weekday: 2, startMinute: 540, endMinute: 1020 },
        { weekday: 3, startMinute: 540, endMinute: 1020 },
        { weekday: 4, startMinute: 540, endMinute: 1020 },
        { weekday: 5, startMinute: 540, endMinute: 1020 },
      ],
    },
  });
});

test("numeric settings accept both bounds and reject invalid integers", () => {
  for (const [key, min, max] of [
    ["durationMinutes", 5, 480],
    ["intervalMinutes", 5, 240],
    ["beforeMinutes", 0, 120],
    ["afterMinutes", 0, 120],
    ["noticeMinutes", 0, 43200],
  ] as const) {
    for (const value of [min, max]) {
      const input = settings();
      input.event[key] = value;
      assert.equal(parseSettings(input).event[key], value);
    }
    for (const value of [min - 1, max + 1, 5.5, NaN, Infinity, "30", null]) {
      assert.throws(() => parseSettings({ ...settings(), event: { ...settings().event, [key]: value } }), {
        name: "SettingsError",
        code: "INVALID_SETTINGS",
      });
    }
  }
});

test("guest change policies preserve absent defaults and accept only explicit booleans", () => {
  assert.equal(parseSettings(settings()).event.disableCancelling, undefined);
  assert.equal(parseSettings(settings()).event.disableRescheduling, undefined);
  for (const key of ["disableCancelling", "disableRescheduling"] as const) {
    for (const value of [true, false]) {
      assert.equal(
        parseSettings({ ...settings(), event: { ...settings().event, [key]: value } }).event[key],
        value
      );
    }
    for (const value of [null, "false", "true", 0, 1, {}, []]) {
      assert.throws(
        () => parseSettings({ ...settings(), event: { ...settings().event, [key]: value } }),
        SettingsError
      );
    }
  }
});

test("text and object validation reject malformed payloads", () => {
  for (const value of [null, [], {}, { event: {}, schedule: {} }]) {
    assert.throws(() => parseSettings(value), SettingsError);
  }
  for (const [key, values] of Object.entries({
    slug: ["", "Bad", "a/b", "-intro", "intro-", "a--b", "a".repeat(101)],
    title: ["", "  ", "a".repeat(101)],
    description: [null, "a".repeat(2001)],
  })) {
    for (const value of values) {
      assert.throws(
        () => parseSettings({ ...settings(), event: { ...settings().event, [key]: value } }),
        SettingsError
      );
    }
  }
  const input = settings();
  input.event.title = "a".repeat(100);
  input.event.description = "a".repeat(2000);
  input.event.slug = "intro-30";
  assert.deepEqual(parseSettings(input), input);
});

test("time zones must be valid named zones", () => {
  for (const timeZone of ["UTC", "Asia/Manila", "America/New_York"]) {
    const input = settings();
    input.schedule.timeZone = timeZone;
    assert.equal(parseSettings(input).schedule.timeZone, timeZone);
  }
  for (const timeZone of ["", "Mars/Olympus", "+01:00", "-0500", null]) {
    assert.throws(
      () => parseSettings({ ...settings(), schedule: { ...settings().schedule, timeZone } }),
      SettingsError
    );
  }
});

test("weekly rules allow adjacency, empty schedules, and day boundaries", () => {
  const input = settings();
  input.schedule.rules = [
    { weekday: 0, startMinute: 0, endMinute: 720 },
    { weekday: 0, startMinute: 720, endMinute: 1440 },
    { weekday: 6, startMinute: 0, endMinute: 1440 },
  ];
  assert.deepEqual(parseSettings(input), input);
  input.schedule.rules = [];
  assert.deepEqual(parseSettings(input).schedule.rules, []);
  input.schedule.rules = Array.from({ length: 28 }, (_, i) => ({
    weekday: i % 7,
    startMinute: Math.floor(i / 7),
    endMinute: Math.floor(i / 7) + 1,
  }));
  assert.equal(parseSettings(input).schedule.rules.length, 28);
  input.schedule.rules.push({ weekday: 0, startMinute: 4, endMinute: 5 });
  assert.throws(() => parseSettings(input), SettingsError);
});

test("weekly rules reject overlaps, duplicates, invalid weekdays and overnight ranges", () => {
  for (const rule of [
    { weekday: -1, startMinute: 0, endMinute: 1 },
    { weekday: 7, startMinute: 0, endMinute: 1 },
    { weekday: 1.5, startMinute: 0, endMinute: 1 },
    { weekday: 1, startMinute: -1, endMinute: 1 },
    { weekday: 1, startMinute: 0.5, endMinute: 1 },
    { weekday: 1, startMinute: 0, endMinute: 1441 },
    { weekday: 1, startMinute: 900, endMinute: 500 },
    { weekday: 1, startMinute: 0, endMinute: 0 },
    { weekday: 1, startMinute: 1440, endMinute: 1440 },
    { weekday: 1, startMinute: 540, endMinute: 1020 },
    { weekday: 1, startMinute: 600, endMinute: 1100 },
  ]) {
    const input = settings();
    input.schedule.rules.push(rule);
    assert.throws(() => parseSettings(input), SettingsError);
  }
});

test("date overrides allow closures and leap dates, rejecting duplicates, overlaps and invalid dates", () => {
  const input = settings();
  input.schedule.overrides = [
    { date: "2028-02-29", ranges: [] },
    { date: "2026-12-25", ranges: [{ startMinute: 0, endMinute: 1440 }] },
  ];
  assert.deepEqual(parseSettings(input), input);
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-1-01", "invalid"]) {
    input.schedule.overrides = [{ date, ranges: [] }];
    assert.throws(() => parseSettings(input), SettingsError);
  }
  input.schedule.overrides = [
    { date: "2026-01-01", ranges: [] },
    { date: "2026-01-01", ranges: [] },
  ];
  assert.throws(() => parseSettings(input), SettingsError);
  input.schedule.overrides = [
    {
      date: "2026-01-01",
      ranges: [
        { startMinute: 0, endMinute: 100 },
        { startMinute: 99, endMinute: 101 },
      ],
    },
  ];
  assert.throws(() => parseSettings(input), SettingsError);
  input.schedule.overrides = Array.from({ length: 366 }, (_, i) => ({
    date: new Date(Date.UTC(2028, 0, i + 1)).toISOString().slice(0, 10),
    ranges: [],
  }));
  assert.equal(parseSettings(input).schedule.overrides?.length, 366);
  input.schedule.overrides.push({ date: "2029-01-01", ranges: [] });
  assert.throws(() => parseSettings(input), SettingsError);
});

test("D1 composes authoritative event and preferences, persists updates and rejects corrupt state", async () => {
  const fixture = await apiFixture();
  try {
    const db = fixture.db;
    await saveSettings(db, defaultSettings);
    const version = await db.prepare("SELECT version FROM organizer_settings").first<number>("version");
    assert.ok(version);
    const first = await getSettings(db);
    assert.deepEqual(first, defaultSettings);
    first.event.title = "Changed locally";
    assert.equal((await getSettings(db)).event.title, "Intro call");
    const input = settings();
    input.event.title = "O'Brien's intro";
    await saveSettings(db, input);
    assert.deepEqual(await getSettings(db), input);
    input.event.durationMinutes = 45;
    await saveSettings(db, input);
    assert.deepEqual(await getSettings(db), input);
    assert.equal(await db.prepare("SELECT count(*) FROM organizer_settings").first("count(*)"), 1);
    assert.equal(await db.prepare("SELECT version FROM organizer_settings").first("version"), version + 2);
    assert.equal(await db.prepare("SELECT count(*) FROM event_type").first("count(*)"), 1);
    assert.equal(
      await db.prepare("SELECT json -> '$.event' AS event FROM organizer_settings").first("event"),
      null
    );
    await assert.rejects(db.prepare("INSERT INTO organizer_settings VALUES ('other', '{}', 1)").run());
    await assert.rejects(db.prepare("UPDATE organizer_settings SET version = 0").run());
    input.event.durationMinutes = 0;
    await assert.rejects(saveSettings(db, input), SettingsError);
    assert.equal((await getSettings(db)).event.durationMinutes, 45);
    for (const json of ["invalid", "{}"]) {
      await db.prepare("UPDATE organizer_settings SET json = ?").bind(json).run();
      await assert.rejects(getSettings(db), SettingsError);
    }
  } finally {
    await fixture.close();
  }
});
