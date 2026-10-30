import type {
  BookingRules,
  EventDetails,
  ScheduleOverrides,
  Settings,
  WeeklySchedule,
} from "../domain/settings.ts";
import {
  defaultSettings,
  parseBookingRules,
  parseEventDetails,
  parseScheduleOverrides,
  parseSettings,
  parseWeeklySchedule,
  SettingsError,
} from "../domain/settings.ts";

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db
    .prepare("SELECT json FROM organizer_settings WHERE id = ?")
    .bind("owner")
    .first<{ json: string }>();
  if (!row) return parseSettings(defaultSettings);
  let input: unknown;
  try {
    input = JSON.parse(row.json);
  } catch {
    throw new SettingsError("Stored settings contain invalid JSON");
  }
  return parseSettings(input);
}

export async function saveSettings(db: D1Database, settings: Settings): Promise<void> {
  const validated = parseSettings(settings);
  await db
    .prepare(
      `INSERT INTO organizer_settings (id, json, version) VALUES (?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, version = organizer_settings.version + 1`
    )
    .bind("owner", JSON.stringify(validated))
    .run();
}

export async function saveEventDetails(db: D1Database, input: EventDetails): Promise<void> {
  const details = parseEventDetails(input);
  const initial = parseSettings({ ...defaultSettings, event: { ...defaultSettings.event, ...details } });
  await db
    .prepare(`INSERT INTO organizer_settings (id, json, version) VALUES ('owner', ?, 1)
      ON CONFLICT(id) DO UPDATE SET json = json_patch(json_set(organizer_settings.json,
        '$.event.slug', ?, '$.event.title', json(?), '$.event.description', json(?), '$.event.durationMinutes', CAST(? AS INTEGER)), json(?)),
        version = organizer_settings.version + 1`)
    .bind(
      JSON.stringify(initial),
      details.slug,
      JSON.stringify(details.title),
      JSON.stringify(details.description),
      details.durationMinutes,
      JSON.stringify(details.location === undefined ? {} : { event: { location: details.location || null } })
    )
    .run();
}

export async function saveWeeklySchedule(db: D1Database, input: WeeklySchedule): Promise<void> {
  const weekly = parseWeeklySchedule(input);
  const initial = parseSettings({ ...defaultSettings, schedule: weekly });
  await db
    .prepare(`INSERT INTO organizer_settings (id, json, version) VALUES ('owner', ?, 1)
    ON CONFLICT(id) DO UPDATE SET json = json_set(organizer_settings.json,
      '$.schedule.timeZone', json(?), '$.schedule.rules', json(?)),
      version = organizer_settings.version + 1`)
    .bind(JSON.stringify(initial), JSON.stringify(weekly.timeZone), JSON.stringify(weekly.rules))
    .run();
}

export async function saveScheduleOverrides(db: D1Database, input: ScheduleOverrides): Promise<void> {
  const { overrides } = parseScheduleOverrides(input);
  const initial = parseSettings({
    ...defaultSettings,
    schedule: { ...defaultSettings.schedule, overrides },
  });
  await db
    .prepare(`INSERT INTO organizer_settings (id, json, version) VALUES ('owner', ?, 1)
    ON CONFLICT(id) DO UPDATE SET json = json_set(organizer_settings.json,
      '$.schedule.overrides', json(?)), version = organizer_settings.version + 1`)
    .bind(JSON.stringify(initial), JSON.stringify(overrides))
    .run();
}

export async function saveBookingRules(db: D1Database, input: BookingRules): Promise<void> {
  const rules = parseBookingRules(input);
  const { bookingWindowDays, ...timing } = rules;
  const initial = parseSettings({
    ...defaultSettings,
    event: {
      ...defaultSettings.event,
      ...timing,
      ...(typeof bookingWindowDays === "number" ? { bookingWindowDays } : {}),
    },
  });
  await db
    .prepare(`INSERT INTO organizer_settings (id, json, version) VALUES ('owner', ?, 1)
    ON CONFLICT(id) DO UPDATE SET json = json_patch(json_patch(json_set(json_remove(organizer_settings.json,
      '$.event.disableCancelling', '$.event.disableRescheduling', '$.event.bookingWindowDays', '$.event.location'),
      '$.event.intervalMinutes', json(?), '$.event.beforeMinutes', json(?),
      '$.event.afterMinutes', json(?), '$.event.noticeMinutes', json(?),
      '$.event.disableCancelling', json(?), '$.event.disableRescheduling', json(?)),
      json_object('event', json_object('bookingWindowDays', CASE WHEN ? THEN json(?)
        ELSE json(organizer_settings.json -> '$.event.bookingWindowDays') END))),
      CASE WHEN json_type(organizer_settings.json, '$.event.location') = 'text'
        THEN json_object('event', json_object('location', json(organizer_settings.json -> '$.event.location')))
        ELSE '{}' END),
      version = organizer_settings.version + 1`)
    .bind(
      JSON.stringify(initial),
      ...[
        rules.intervalMinutes,
        rules.beforeMinutes,
        rules.afterMinutes,
        rules.noticeMinutes,
        rules.disableCancelling,
        rules.disableRescheduling,
      ].map((value) => JSON.stringify(value)),
      Object.hasOwn(rules, "bookingWindowDays") ? 1 : 0,
      JSON.stringify(bookingWindowDays ?? null)
    )
    .run();
}
