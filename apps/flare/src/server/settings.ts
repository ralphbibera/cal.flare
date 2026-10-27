import type { Settings } from "../domain/settings.ts";
import { defaultSettings, parseSettings, SettingsError } from "../domain/settings.ts";

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
