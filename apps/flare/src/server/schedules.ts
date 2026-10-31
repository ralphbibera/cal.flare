import type { AvailabilitySchedule } from "../domain/settings.ts";
import { defaultSettings, isScheduleId, parseSettings } from "../domain/settings.ts";
import { ErrorWithCode, record } from "./http.ts";
import { eventId, getOwnerPreferences } from "./settings.ts";

type Database = Pick<D1Database, "prepare" | "batch">;
type StoredSchedule = { id: string; name: string; json: string };

export function scheduleId(value: unknown): string {
  if (!isScheduleId(value)) throw new ErrorWithCode("not_found", 404);
  return value;
}

export function scheduleName(input: unknown): string {
  const data = record(input);
  if (Object.keys(data).length !== 1 || typeof data.name !== "string")
    throw new ErrorWithCode("invalid_input");
  const name = data.name.trim();
  if (!name || name.length > 100) throw new ErrorWithCode("invalid_input");
  return name;
}

function scheduleRecord(row: StoredSchedule): AvailabilitySchedule {
  return {
    id: row.id,
    name: row.name,
    schedule: parseSettings({ ...defaultSettings, schedule: JSON.parse(row.json) }).schedule,
  };
}

export async function getSchedule(db: Database, id: string): Promise<AvailabilitySchedule> {
  const row = await db
    .prepare("SELECT id,name,json FROM availability_schedule WHERE id=?")
    .bind(scheduleId(id))
    .first<StoredSchedule>();
  if (!row) throw new ErrorWithCode("not_found", 404);
  return scheduleRecord(row);
}

export async function listSchedules(db: Database) {
  const rows = await db
    .prepare(`SELECT s.id,s.name,s.json,o.default_schedule_id FROM availability_schedule s
    JOIN organizer_settings o ON o.id='owner' ORDER BY s.rowid`)
    .all<StoredSchedule & { default_schedule_id: string }>();
  const defaultScheduleId = rows.results[0]?.default_schedule_id;
  if (!defaultScheduleId) throw new ErrorWithCode("temporarily_unavailable", 503);
  return { defaultScheduleId, schedules: rows.results.map(scheduleRecord) };
}

export async function createSchedule(db: Database, name: string): Promise<AvailabilitySchedule> {
  await getOwnerPreferences(db);
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO availability_schedule(id,name,json,version)
    SELECT ?,?,json_set(json(?),'$.timeZone',json_extract(s.json,'$.timeZone')),1
    FROM organizer_settings o JOIN availability_schedule s ON s.id=o.default_schedule_id WHERE o.id='owner'`)
    .bind(id, name, JSON.stringify(defaultSettings.schedule))
    .run();
  return getSchedule(db, id);
}

export async function duplicateSchedule(
  db: Database,
  source: string,
  name: string
): Promise<AvailabilitySchedule> {
  await getSchedule(db, source);
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO availability_schedule(id,name,json,version)
    SELECT ?,?,json,1 FROM availability_schedule WHERE id=?`)
    .bind(id, name, source)
    .run();
  return getSchedule(db, id);
}

export async function renameSchedule(db: Database, id: string, name: string): Promise<void> {
  if (
    (await db.prepare("UPDATE availability_schedule SET name=? WHERE id=?").bind(name, id).run()).meta
      .changes !== 1
  )
    throw new ErrorWithCode("not_found", 404);
}

export async function setDefaultSchedule(db: Database, id: string): Promise<void> {
  await getSchedule(db, id);
  const result = await db
    .prepare(`UPDATE organizer_settings SET default_schedule_id=? WHERE id='owner'
    AND EXISTS(SELECT 1 FROM availability_schedule WHERE id=?)`)
    .bind(id, id)
    .run();
  if (result.meta.changes !== 1) throw new ErrorWithCode("not_found", 404);
}

export async function assignSchedule(db: Database, id: string, target: string | null): Promise<void> {
  if (target !== null) await getSchedule(db, target);
  const result = await db
    .prepare(`UPDATE event_type SET schedule_id=? WHERE id=? AND lifecycle <> 'removed'
    AND (? IS NULL OR EXISTS(SELECT 1 FROM availability_schedule WHERE id=?))`)
    .bind(target, eventId(id), target, target)
    .run();
  if (result.meta.changes !== 1) throw new ErrorWithCode("not_found", 404);
}

export async function deleteSchedule(db: Database, id: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM availability_schedule WHERE id=?").bind(id).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("final_schedule"))
      throw new ErrorWithCode("final_schedule", 409);
    throw error;
  }
}
