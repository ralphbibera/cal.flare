import type { EventDetails, Settings, WeeklySchedule } from "../domain/settings.ts";
import {
  defaultSettings,
  parseEventDetails,
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
      ON CONFLICT(id) DO UPDATE SET json = json_set(organizer_settings.json,
        '$.event.slug', ?, '$.event.title', json(?), '$.event.description', json(?), '$.event.durationMinutes', CAST(? AS INTEGER)),
        version = organizer_settings.version + 1`)
    .bind(
      JSON.stringify(initial),
      details.slug,
      JSON.stringify(details.title),
      JSON.stringify(details.description),
      details.durationMinutes
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
