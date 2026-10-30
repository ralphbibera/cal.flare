import type {
  BookingRules,
  EventDetails,
  EventSettings,
  OwnerEvent,
  ScheduleOverrides,
  Settings,
  WeeklySchedule,
} from "../domain/settings.ts";
import {
  DEFAULT_EVENT_ID,
  defaultSettings,
  isEventId,
  parseBookingRules,
  parseConflictCalendarIds,
  parseEventDetails,
  parseScheduleOverrides,
  parseSettings,
  parseWeeklySchedule,
  SettingsError,
} from "../domain/settings.ts";
import { ErrorWithCode } from "./http.ts";

type SettingsDatabase = Pick<D1Database, "prepare" | "batch">;
type StoredSettings = { event_json: string | null; preferences_json: string | null };
type CurrentActionPolicy = Pick<EventSettings, "disableCancelling" | "disableRescheduling">;

function eventId(value: string): string {
  if (!isEventId(value)) throw new ErrorWithCode("not_found", 404);
  return value;
}

function storedSettings(row: StoredSettings): Settings {
  if (row.event_json === null || row.preferences_json === null)
    throw new SettingsError("Missing current settings");
  let event: unknown;
  let preferences: unknown;
  try {
    preferences = JSON.parse(row.preferences_json);
    event = JSON.parse(row.event_json);
  } catch (error) {
    if (error instanceof SyntaxError) throw new SettingsError("Stored settings contain invalid JSON");
    throw error;
  }
  if (typeof preferences !== "object" || preferences === null || Array.isArray(preferences))
    throw new SettingsError("Owner preferences must be an object");
  if (Object.keys(preferences).some((key) => !["schedule", "conflictCalendarIds"].includes(key)))
    throw new SettingsError("Owner preferences contain unsupported fields");
  return parseSettings({ ...preferences, event });
}

async function readSettings(db: SettingsDatabase, id: string): Promise<StoredSettings | null> {
  return db
    .prepare(`SELECT e.json AS event_json, o.json AS preferences_json FROM event_type e
      LEFT JOIN organizer_settings o ON o.id='owner' WHERE e.id=?`)
    .bind(eventId(id))
    .first<StoredSettings>();
}

async function getSettings(db: SettingsDatabase, id: string = DEFAULT_EVENT_ID): Promise<Settings> {
  const row = await readSettings(db, id);
  if (!row) throw new ErrorWithCode("not_found", 404);
  return storedSettings(row);
}

function currentActionPolicy(row: StoredSettings | null): CurrentActionPolicy {
  try {
    if (!row) throw new SettingsError("Missing current event");
    const { disableCancelling, disableRescheduling } = storedSettings(row).event;
    return {
      ...(disableCancelling === undefined ? {} : { disableCancelling }),
      ...(disableRescheduling === undefined ? {} : { disableRescheduling }),
    };
  } catch (error) {
    if (error instanceof SettingsError) return { disableCancelling: true, disableRescheduling: true };
    throw error;
  }
}

async function getCurrentActionPolicy(db: SettingsDatabase, id: string): Promise<CurrentActionPolicy> {
  return currentActionPolicy(await readSettings(db, id));
}

async function listEvents(db: SettingsDatabase): Promise<OwnerEvent[]> {
  const rows = await db
    .prepare(`SELECT e.id,e.json AS event_json,o.json AS preferences_json
    FROM event_type e LEFT JOIN organizer_settings o ON o.id='owner' ORDER BY e.rowid`)
    .all<{ id: string; event_json: string; preferences_json: string | null }>();
  return rows.results.map((row) => ({ id: row.id, event: storedSettings(row).event }));
}

async function findEventBySlug(db: SettingsDatabase, slug: string): Promise<string | null> {
  return db
    .prepare("SELECT id FROM event_type WHERE json_extract(json,'$.slug')=?")
    .bind(slug)
    .first<string>("id");
}

async function eventWrite(statement: D1PreparedStatement): Promise<void> {
  try {
    const result = await statement.run();
    if (result.meta.changes !== 1) throw new ErrorWithCode("not_found", 404);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed: index 'event_type_slug'"))
      throw new ErrorWithCode("slug_conflict", 409);
    throw error;
  }
}

async function createEvent(db: SettingsDatabase, input: EventDetails): Promise<OwnerEvent> {
  const details = parseEventDetails(input);
  const event = parseSettings({ ...defaultSettings, event: { ...defaultSettings.event, ...details } }).event;
  const id = crypto.randomUUID();
  await eventWrite(
    db.prepare("INSERT INTO event_type(id,json,version) VALUES (?,?,1)").bind(id, JSON.stringify(event))
  );
  return { id, event };
}

async function saveSettings(db: D1Database, settings: Settings): Promise<void> {
  const { event, ...preferences } = parseSettings(settings);
  try {
    const results = await db.batch([
      db
        .prepare(`UPDATE event_type SET json=?,version=version+1 WHERE id='default'
          AND EXISTS(SELECT 1 FROM organizer_settings WHERE id='owner')`)
        .bind(JSON.stringify(event)),
      db
        .prepare(`UPDATE organizer_settings SET json=?,version=version+1 WHERE id='owner'
          AND EXISTS(SELECT 1 FROM event_type WHERE id='default')`)
        .bind(JSON.stringify(preferences)),
    ]);
    if (results.some((result) => result.meta.changes !== 1))
      throw new SettingsError("Missing authoritative settings");
  } catch (error) {
    if (error instanceof Error && error.message.includes("event_type_slug"))
      throw new ErrorWithCode("slug_conflict", 409);
    throw error;
  }
}

async function saveConflictCalendars(db: D1Database, input: string[] | null): Promise<void> {
  const ids = input === null ? null : parseConflictCalendarIds(input);
  const patch = ids === null ? {} : { conflictCalendarIds: ids };
  await preferencesWrite(
    db
      .prepare(`UPDATE organizer_settings SET json = json_patch(
        json_remove(organizer_settings.json, '$.conflictCalendarIds'), json(?)),
        version = version + 1 WHERE id='owner'`)
      .bind(JSON.stringify(patch))
  );
}

async function preferencesWrite(statement: D1PreparedStatement): Promise<void> {
  if ((await statement.run()).meta.changes !== 1) throw new SettingsError("Missing owner preferences");
}

async function saveEventDetails(
  db: D1Database,
  input: EventDetails,
  id: string = DEFAULT_EVENT_ID
): Promise<void> {
  const details = parseEventDetails(input);
  let location = "json";
  const values: string[] = [];
  if (details.location !== undefined) location = "json_remove(json,'$.location')";
  if (details.location) {
    location = "json_set(json_remove(json,'$.location'),'$.location',json(?))";
    values.push(JSON.stringify(details.location));
  }
  await eventWrite(
    db
      .prepare(`UPDATE event_type SET json=json_set(${location},
        '$.slug', ?, '$.title', json(?), '$.description', json(?), '$.durationMinutes', CAST(? AS INTEGER)),
        version=version+1 WHERE id=?`)
      .bind(
        ...values,
        details.slug,
        JSON.stringify(details.title),
        JSON.stringify(details.description),
        details.durationMinutes,
        eventId(id)
      )
  );
}

async function saveWeeklySchedule(db: D1Database, input: WeeklySchedule): Promise<void> {
  const weekly = parseWeeklySchedule(input);
  await preferencesWrite(
    db
      .prepare(`UPDATE organizer_settings SET json = json_set(organizer_settings.json,
      '$.schedule.timeZone', json(?), '$.schedule.rules', json(?)),
      version = version + 1 WHERE id='owner'`)
      .bind(JSON.stringify(weekly.timeZone), JSON.stringify(weekly.rules))
  );
}

async function saveScheduleOverrides(db: D1Database, input: ScheduleOverrides): Promise<void> {
  const { overrides } = parseScheduleOverrides(input);
  await preferencesWrite(
    db
      .prepare(`UPDATE organizer_settings SET json = json_set(organizer_settings.json,
      '$.schedule.overrides', json(?)), version = version + 1 WHERE id='owner'`)
      .bind(JSON.stringify(overrides))
  );
}

async function saveBookingRules(
  db: D1Database,
  input: BookingRules,
  id: string = DEFAULT_EVENT_ID
): Promise<void> {
  const rules = parseBookingRules(input);
  const { bookingWindowDays } = rules;
  const timing = [
    rules.intervalMinutes,
    rules.beforeMinutes,
    rules.afterMinutes,
    rules.noticeMinutes,
    rules.disableCancelling,
    rules.disableRescheduling,
  ].map((value) => JSON.stringify(value));
  await eventWrite(
    db
      .prepare(`WITH updated AS MATERIALIZED (
      SELECT json_set(json_remove(json,'$.disableCancelling','$.disableRescheduling','$.bookingWindowDays','$.location'),
        '$.intervalMinutes',json(?),'$.beforeMinutes',json(?),'$.afterMinutes',json(?),'$.noticeMinutes',json(?),
        '$.disableCancelling',json(?),'$.disableRescheduling',json(?)) AS timing,
        CASE WHEN ? THEN ? ELSE json -> '$.bookingWindowDays' END AS window_json,
        json -> '$.location' AS location_json FROM event_type WHERE id=?)
      UPDATE event_type SET json=(SELECT substr(timing,1,length(timing)-1)
        || CASE WHEN window_json IS NULL THEN '' ELSE ',"bookingWindowDays":'||window_json END
        || CASE WHEN location_json IS NULL THEN '' ELSE ',"location":'||location_json END || '}' FROM updated),
        version=version+1 WHERE id=?`)
      .bind(
        ...timing,
        Object.hasOwn(rules, "bookingWindowDays") ? 1 : 0,
        bookingWindowDays == null ? null : JSON.stringify(bookingWindowDays),
        eventId(id),
        eventId(id)
      )
  );
}

export type { CurrentActionPolicy, OwnerEvent };
export {
  createEvent,
  currentActionPolicy,
  DEFAULT_EVENT_ID,
  eventId,
  findEventBySlug,
  getCurrentActionPolicy,
  getSettings,
  listEvents,
  saveBookingRules,
  saveConflictCalendars,
  saveEventDetails,
  saveScheduleOverrides,
  saveSettings,
  saveWeeklySchedule,
};
