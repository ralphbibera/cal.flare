import common from "../../../../packages/i18n/locales/en/common.json" with { type: "json" };
import { isValidTimeZone, MAX_QUERY_DAYS } from "../domain/scheduling.ts";
import type { OwnerEventMode, Settings } from "../domain/settings.ts";
import {
  defaultSettings,
  isScheduleId,
  parseBookingRules,
  parseConflictCalendars,
  parseEventDetails,
  parseScheduleOverrides,
  parseSettings,
  parseWeeklySchedule,
} from "../domain/settings.ts";
import type { AuthEnv } from "./auth.ts";
import { beginLogin, finishLogin, logout, requireOwner } from "./auth.ts";
import { parseOwnerBookingQuery } from "./booking-model.ts";
import { BookingService } from "./bookings.ts";
import type { GoogleCalendar } from "./google.ts";
import { GoogleCalendar as CalendarClient } from "./google.ts";
import { bearer, body, ErrorWithCode, json, record, sameOrigin } from "./http.ts";
import {
  assignSchedule,
  createSchedule,
  deleteSchedule,
  duplicateSchedule,
  getSchedule,
  listSchedules,
  renameSchedule,
  scheduleId,
  scheduleName,
  setDefaultSchedule,
} from "./schedules.ts";
import { hash } from "./secrets.ts";
import {
  createEvent,
  DEFAULT_EVENT_ID,
  duplicateEvent,
  eventId,
  getAdmissionContext,
  getBookableSettings,
  getOwnerEvent,
  getOwnerPreferences,
  getSettings,
  listEvents,
  listPublicEvents,
  removeEvent,
  saveBookingRules,
  saveConflictCalendars,
  saveEventDetails,
  saveScheduleOverrides,
  saveSettings,
  saveWeeklySchedule,
  setEventVisibility,
} from "./settings.ts";

type Dependencies = {
  env: AuthEnv;
  calendar?: Pick<GoogleCalendar, "busy" | "insert" | "get" | "update" | "delete">;
  now?: () => number;
};
type PublicEventMetadata = {
  id: string;
  organizer: { name: string };
  event: Omit<Settings["event"], "location">;
  schedule: Settings["schedule"];
};

async function limitCreate(db: D1Database, request: Request, input: unknown, now: number): Promise<void> {
  const key = record(input).requestKey;
  if (typeof key !== "string" || key.length > 128) throw new ErrorWithCode("invalid_request_key");
  const bucket = Math.floor(now / 3_600_000);
  const ip = await hash(request.headers.get("CF-Connecting-IP") ?? "local");
  const identity = await hash(key);
  const results = await db.batch([
    db.prepare("DELETE FROM http_attempt WHERE bucket < ?").bind(bucket - 24),
    db
      .prepare(`INSERT OR IGNORE INTO http_attempt (bucket, identity, ip_hash)
      SELECT ?, ?, ? WHERE
      (SELECT count(*) FROM http_attempt WHERE bucket = ? AND ip_hash = ?) < 10
      AND (SELECT count(*) FROM http_attempt WHERE bucket = ?) < 100`)
      .bind(bucket, identity, ip, bucket, ip, bucket),
    db.prepare("SELECT identity FROM http_attempt WHERE bucket = ? AND identity = ?").bind(bucket, identity),
  ]);
  if (results[2]?.results.length !== 1) throw new ErrorWithCode("too_many_requests", 429);
}

async function limitAvailability(db: D1Database, request: Request, now: number): Promise<void> {
  const bucket = Math.floor(now / 60_000);
  const ip = `slots:${await hash(request.headers.get("CF-Connecting-IP") ?? "local")}`;
  const results = await db.batch<{ key: string; n: number }>([
    db.prepare("DELETE FROM http_rate WHERE bucket < ?").bind(bucket - 5),
    db
      .prepare(`INSERT INTO http_rate VALUES (?, 'slots:all', 1)
      ON CONFLICT(bucket,key) DO UPDATE SET n = MIN(n + 1, 601)`)
      .bind(bucket),
    db
      .prepare(`INSERT INTO http_rate SELECT ?, ?, 1
      WHERE (SELECT n FROM http_rate WHERE bucket = ? AND key = 'slots:all') <= 600
      ON CONFLICT(bucket,key) DO UPDATE SET n = MIN(n + 1, 61)`)
      .bind(bucket, ip, bucket),
    db.prepare("SELECT key,n FROM http_rate WHERE bucket = ? AND key IN ('slots:all', ?)").bind(bucket, ip),
  ]);
  const counts = results[3]?.results;
  if (
    !counts ||
    counts.length !== 2 ||
    counts.some((row) => typeof row.n !== "number" || row.n > 600 || (row.key === ip && row.n > 60))
  ) {
    throw new ErrorWithCode("too_many_requests", 429);
  }
}

async function owner(env: AuthEnv, request: Request) {
  const identity = await requireOwner(env, request);
  if (!identity) throw new ErrorWithCode("unauthorized", 401);
  return identity;
}

async function connectedOwner(env: AuthEnv): Promise<{ name: string }> {
  const email = env.GOOGLE_OWNER_EMAIL?.toLowerCase() ?? "";
  const identity = await env.DB.prepare(`SELECT o.name FROM owner o
    JOIN google_connection g ON g.owner_id = o.id WHERE o.id = 'owner' AND o.email = ?`)
    .bind(email)
    .first<{ name: string }>();
  if (!identity) throw new ErrorWithCode("setup_required", 503);
  const name = identity.name.trim();
  return { name: !name || name.toLowerCase().includes(email) ? common.organizer : name };
}

async function getPublicBooking(env: AuthEnv, id = DEFAULT_EVENT_ID) {
  const organizer = await connectedOwner(env);
  const { event, schedule } = await getBookableSettings(env.DB, id);
  const { location: _location, ...publicEvent } = event;
  return { organizer, event: publicEvent, schedule };
}

async function getPublicDirectory(env: AuthEnv) {
  const organizer = await connectedOwner(env);
  return { organizer, events: await listPublicEvents(env.DB) };
}

function bookingResponse(value: Awaited<ReturnType<BookingService["view"]>>, created = false): Response {
  if (!["confirmed", "cancelled"].includes(value.status)) return json(value, 202);
  if (created) return json(value, 201);
  return json(value);
}

function bookingService(dependencies: Dependencies): BookingService {
  return new BookingService({
    db: dependencies.env.DB,
    calendar: dependencies.calendar ?? new CalendarClient(dependencies.env),
    secret: dependencies.env.TOKEN_ENCRYPTION_KEY,
    now: dependencies.now,
  });
}

async function validateConflictCalendars(env: AuthEnv, ids?: string[] | null): Promise<void> {
  if (!ids?.length) return;
  const calendars = await new CalendarClient(env).listCalendars();
  const allowed = new Set(calendars.map((calendar) => calendar.id));
  if (ids.some((id) => !allowed.has(id))) throw new ErrorWithCode("invalid_calendar_selection");
}

async function eventLifecycle(
  request: Request,
  db: D1Database,
  id: string,
  action?: string
): Promise<Response | null> {
  const method = request.method;
  if (method === "DELETE" && !action) {
    if ((await request.text()) !== "") throw new ErrorWithCode("invalid_input");
    await removeEvent(db, id);
    return json({ saved: true });
  }
  if (method === "POST" && action === "/duplicate") {
    const input = record(await body(request));
    if (Object.keys(input).length !== 4 || Object.hasOwn(input, "location"))
      throw new ErrorWithCode("invalid_input");
    return json(await duplicateEvent(db, id, parseEventDetails(input)), 201);
  }
  if (method !== "PATCH" || action !== "/visibility") return null;
  const value = record(await body(request));
  if (Object.keys(value).length !== 1 || typeof value.hidden !== "boolean")
    throw new ErrorWithCode("invalid_input");
  await setEventVisibility(db, id, value.hidden);
  return json({ saved: true });
}

async function ownerEvents(request: Request, { env }: Dependencies, url: URL): Promise<Response> {
  await owner(env, request);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) sameOrigin(request, env.PUBLIC_ORIGIN);
  if (url.search) throw new ErrorWithCode("invalid_query");
  const method = request.method;
  if (url.pathname === "/api/owner/events") {
    if (method === "GET") return json({ events: await listEvents(env.DB) });
    if (method === "POST")
      return json(await createEvent(env.DB, parseEventDetails(await body(request))), 201);
    return json({ error: "not_found" }, 404);
  }
  const target = /^\/api\/owner\/events\/([^/]+)(\/(?:booking-rules|duplicate|visibility|schedule))?$/.exec(
    url.pathname
  );
  if (!target) throw new ErrorWithCode("not_found", 404);
  const id = eventId(target[1]);
  const lifecycle = await eventLifecycle(request, env.DB, id, target[2]);
  if (lifecycle) return lifecycle;
  const selected = target[2] === "/schedule" ? null : await getOwnerEvent(env.DB, id);
  if (method === "GET" && !target[2]) return json(selected);
  if (method !== "PATCH") return json({ error: "not_found" }, 404);
  const input = await body(request);
  await ownerEventPatch(env.DB, id, target[2], input);
  return json({ saved: true });
}

async function ownerEventPatch(
  db: D1Database,
  id: string,
  action: string | undefined,
  input: unknown
): Promise<void> {
  if (action === "/schedule") {
    const data = record(input);
    if (Object.keys(data).length !== 1 || !Object.hasOwn(data, "scheduleId"))
      throw new ErrorWithCode("invalid_input");
    await assignSchedule(db, id, data.scheduleId === null ? null : scheduleId(data.scheduleId));
    return;
  }
  if (action === "/booking-rules") return saveBookingRules(db, parseBookingRules(input), id);
  if (action) throw new ErrorWithCode("not_found", 404);
  await saveEventDetails(db, parseEventDetails(input), id);
}

async function ownerSchedulePatch(
  db: D1Database,
  id: string,
  action: string | undefined,
  input: unknown
): Promise<void> {
  if (!action) return renameSchedule(db, id, scheduleName(input));
  if (action === "/default") {
    if (Object.keys(record(input)).length) throw new ErrorWithCode("invalid_input");
    return setDefaultSchedule(db, id);
  }
  await getSchedule(db, id);
  if (action === "/weekly") return saveWeeklySchedule(db, parseWeeklySchedule(input), id);
  if (action === "/overrides") return saveScheduleOverrides(db, parseScheduleOverrides(input), id);
  throw new ErrorWithCode("not_found", 404);
}

async function ownerScheduleCatalog(request: Request, db: D1Database): Promise<Response> {
  if (request.method === "GET") return json(await listSchedules(db));
  if (request.method === "POST")
    return json(await createSchedule(db, scheduleName(await body(request))), 201);
  throw new ErrorWithCode("not_found", 404);
}

async function ownerSchedules(request: Request, { env }: Dependencies, url: URL): Promise<Response> {
  await owner(env, request);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) sameOrigin(request, env.PUBLIC_ORIGIN);
  if (url.search) throw new ErrorWithCode("invalid_query");
  const method = request.method;
  if (url.pathname === "/api/owner/schedules") return ownerScheduleCatalog(request, env.DB);
  const target = /^\/api\/owner\/schedules\/([^/]+)(\/(?:weekly|overrides|duplicate|default))?$/.exec(
    url.pathname
  );
  if (!target) throw new ErrorWithCode("not_found", 404);
  const id = scheduleId(target[1]);
  const action = target[2];
  if (!action && method === "GET") return json(await getSchedule(env.DB, id));
  if (!action && method === "DELETE") {
    if ((await request.text()) !== "") throw new ErrorWithCode("invalid_input");
    await deleteSchedule(env.DB, id);
    return json({ saved: true });
  }
  if (action === "/duplicate" && method === "POST")
    return json(await duplicateSchedule(env.DB, id, scheduleName(await body(request))), 201);
  if (method !== "PATCH") throw new ErrorWithCode("not_found", 404);
  await ownerSchedulePatch(env.DB, id, action, await body(request));
  return json({ saved: true });
}

export async function getOwnerData(request: Request, dependencies: Dependencies) {
  const identity = await requireOwner(dependencies.env, request);
  if (!identity) return null;
  const settings = await getSettings(dependencies.env.DB);
  return { owner: identity, settings, bookings: await bookingService(dependencies).ownerList() };
}

export async function getOwnerEventData(request: Request, dependencies: Dependencies) {
  const identity = await requireOwner(dependencies.env, request);
  if (!identity) return null;
  const url = new URL(request.url);
  const ids = url.searchParams.getAll("eventId");
  const modes = url.searchParams.getAll("create");
  const duplicates = url.searchParams.getAll("duplicate");
  if (
    ids.length > 1 ||
    modes.length > 1 ||
    duplicates.length > 1 ||
    ids.length + modes.length + duplicates.length > 1 ||
    (modes.length && modes[0] !== "1")
  )
    throw new ErrorWithCode("invalid_query");
  const events = await listEvents(dependencies.env.DB);
  const selectedId = eventId(ids[0] ?? duplicates[0] ?? events[0]?.id ?? DEFAULT_EVENT_ID);
  const creating = modes.length === 1 || (!ids.length && !duplicates.length && events.length === 0);
  const selected = creating ? null : await getOwnerEvent(dependencies.env.DB, selectedId);
  let mode: OwnerEventMode = { kind: "create" };
  if (selected) mode = { kind: "edit", id: selected.id, lifecycle: selected.lifecycle };
  if (selected && duplicates.length) mode = { kind: "duplicate", id: selected.id };
  const preferences = await getOwnerPreferences(dependencies.env.DB);
  const context = selected ? await getAdmissionContext(dependencies.env.DB, selected.id) : null;
  const settings = context?.settings ?? { ...preferences, event: defaultSettings.event };
  const catalog = await ownerScheduleCatalogData(dependencies.env.DB);
  return {
    owner: identity,
    settings,
    scheduleId: context?.resolvedScheduleId ?? catalog.defaultScheduleId,
    eventScheduleId: context?.eventScheduleId ?? null,
    catalog,
    bookingsTimeZone: preferences.schedule.timeZone,
    selectedId,
    creating,
    mode,
    events,
    bookings: await bookingService(dependencies).ownerList(),
  };
}

async function ownerScheduleCatalogData(db: D1Database) {
  const catalog = await listSchedules(db);
  if (
    !catalog.schedules.some(({ id }) => id === catalog.defaultScheduleId) ||
    catalog.schedules.some(
      ({ id, name }) => !isScheduleId(id) || !name.trim() || name.trim() !== name || name.length > 100
    )
  )
    throw new ErrorWithCode("temporarily_unavailable", 503);
  return catalog;
}

export async function getOwnerSchedules(request: Request, dependencies: Dependencies) {
  if (!(await requireOwner(dependencies.env, request))) return null;
  const query = new URL(request.url).searchParams;
  const ids = query.getAll("scheduleId");
  if (ids.length > 1 || [...query.keys()].some((key) => key !== "scheduleId"))
    throw new ErrorWithCode("invalid_query");
  const selectedId = ids.length ? scheduleId(ids[0]) : null;
  const catalog = await ownerScheduleCatalogData(dependencies.env.DB);
  const selected = catalog.schedules.find(({ id }) => id === (selectedId ?? catalog.defaultScheduleId));
  if (!selected) throw new ErrorWithCode("not_found", 404);
  return { catalog, selectedId: selected.id };
}

export async function getOwnerBookings(request: Request, dependencies: Dependencies) {
  if (!(await requireOwner(dependencies.env, request))) return null;
  const query = parseOwnerBookingQuery(new URL(request.url).searchParams);
  const settings = await getOwnerPreferences(dependencies.env.DB);
  return {
    query,
    timeZone: settings.schedule.timeZone,
    ...(await bookingService(dependencies).ownerPage(query)),
  };
}

export async function getOwnerBooking(request: Request, dependencies: Dependencies, id: string) {
  if (!(await requireOwner(dependencies.env, request))) return null;
  return bookingService(dependencies).ownerView(id);
}

function authRoute(request: Request, env: AuthEnv, path: string): Promise<Response> | null {
  const method = request.method;
  if (path === "/api/auth/login" && method === "GET") return beginLogin(env, request);
  if (path === "/api/auth/callback" && method === "GET") return finishLogin(env, request);
  if (path === "/api/auth/logout" && method === "POST") return logout(env, request);
  return null;
}

async function publicEventRoute(
  request: Request,
  dependencies: Dependencies,
  url: URL
): Promise<Response | null> {
  const target = /^\/api\/events\/([^/]+)(\/(?:slots|bookings))?$/.exec(url.pathname);
  if (!target) return null;
  const { env } = dependencies;
  const selectedEventId = eventId(target[1]);
  if (!target[2] && request.method === "GET") {
    if (url.search) throw new ErrorWithCode("invalid_query");
    return json({
      id: selectedEventId,
      ...(await getPublicBooking(env, selectedEventId)),
    } satisfies PublicEventMetadata);
  }
  const exists = await env.DB.prepare("SELECT id FROM event_type WHERE id=?")
    .bind(selectedEventId)
    .first<string>("id");
  if (!exists) throw new ErrorWithCode("not_found", 404);
  const allowed = target[2] === "/slots" ? ["from", "to", "timeZone"] : [];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new ErrorWithCode("invalid_query");
  }
  const service = bookingService(dependencies);
  return (
    (await publicBookingRoute(request, dependencies, url, service, selectedEventId, undefined, target[2])) ??
    json({ error: "not_found" }, 404)
  );
}

async function ownerConflictCalendars(request: Request, env: AuthEnv, url: URL): Promise<Response> {
  await owner(env, request);
  if (url.search) throw new ErrorWithCode("invalid_query");
  if (request.method === "GET")
    return json({
      calendars: await new CalendarClient(env).listCalendars(),
      conflictCalendarIds: (await getOwnerPreferences(env.DB)).conflictCalendarIds ?? null,
    });
  if (request.method === "PATCH") {
    await getOwnerPreferences(env.DB);
    const ids = parseConflictCalendars(await body(request));
    await validateConflictCalendars(env, ids);
    await saveConflictCalendars(env.DB, ids);
    return json({ saved: true });
  }
  return json({ error: "not_found" }, 404);
}

async function ownerConfigurationRoute(
  request: Request,
  dependencies: Dependencies,
  url: URL
): Promise<Response | null> {
  const { env } = dependencies;
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/owner" && method === "GET") {
    const data = await getOwnerData(request, dependencies);
    if (!data) throw new ErrorWithCode("unauthorized", 401);
    return json(data);
  }
  if (path === "/api/owner/conflict-calendars") return ownerConflictCalendars(request, env, url);
  if (path === "/api/owner/schedule" && method === "PATCH") {
    await owner(env, request);
    await getOwnerPreferences(env.DB);
    await saveWeeklySchedule(env.DB, parseWeeklySchedule(await body(request)));
    return json({ saved: true });
  }
  if (path === "/api/owner/overrides" && method === "PATCH") {
    await owner(env, request);
    await getOwnerPreferences(env.DB);
    await saveScheduleOverrides(env.DB, parseScheduleOverrides(await body(request)));
    return json({ saved: true });
  }
  if (path === "/api/owner/booking-rules" && method === "PATCH") {
    await owner(env, request);
    await getBookableSettings(env.DB);
    await saveBookingRules(env.DB, parseBookingRules(await body(request)));
    return json({ saved: true });
  }
  return null;
}

async function ownerBookingRoute(
  request: Request,
  dependencies: Dependencies,
  path: string
): Promise<Response | null> {
  const { env } = dependencies;
  const method = request.method;
  const ownerBooking = /^\/api\/owner\/bookings\/([^/]+)$/.exec(path);
  if (!ownerBooking) return null;
  await owner(env, request);
  const service = bookingService(dependencies);
  if (method === "GET") return json(await service.ownerView(ownerBooking[1]));
  if (method === "POST")
    return bookingResponse(await service.ownerChange(ownerBooking[1], await body(request)));
  return json({ error: "not_found" }, 404);
}

async function legacyOwnerMutation(
  request: Request,
  env: AuthEnv,
  path: string,
  service: BookingService
): Promise<Response | null> {
  const method = request.method;
  if (path === "/api/owner") {
    await owner(env, request);
    await getBookableSettings(env.DB);
    if (method === "PUT") {
      const replacement = parseSettings(await body(request));
      await validateConflictCalendars(env, replacement.conflictCalendarIds);
      await saveSettings(env.DB, replacement);
      return json({ saved: true });
    }
    if (method === "PATCH") {
      await saveEventDetails(env.DB, parseEventDetails(await body(request)));
      return json({ saved: true });
    }
    return json({ error: "not_found" }, 404);
  }
  if (path === "/api/owner/retry" && method === "POST") {
    await owner(env, request);
    const input = record(await body(request));
    if (typeof input.id !== "string") throw new ErrorWithCode("invalid_booking");
    return bookingResponse(await service.ownerRetry(input.id));
  }
  return null;
}

function ownerSlotQuery(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (!["from", "to", "timeZone"].includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new ErrorWithCode("invalid_range");
  }
  for (const key of ["from", "to"]) {
    const value = url.searchParams.get(key) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
      throw new ErrorWithCode("invalid_range");
  }
}

async function bookingSlots(
  request: Request,
  dependencies: Dependencies,
  url: URL,
  service: BookingService,
  selectedEventId: string,
  ownerBookingId?: string
): Promise<Response> {
  const { env } = dependencies;
  await limitAvailability(env.DB, request, (dependencies.now ?? Date.now)());
  await connectedOwner(env);
  if (ownerBookingId) ownerSlotQuery(url);
  const zone = url.searchParams.get("timeZone");
  if (!zone || !isValidTimeZone(zone)) throw new ErrorWithCode("invalid_time_zone");
  const from = Date.parse(url.searchParams.get("from") ?? "");
  const to = Date.parse(url.searchParams.get("to") ?? "");
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    to - from > MAX_QUERY_DAYS * 86_400_000
  ) {
    throw new ErrorWithCode("invalid_range");
  }
  if (ownerBookingId) return json({ slots: await service.ownerAvailability(ownerBookingId, from, to, zone) });
  const id = url.searchParams.get("bookingId");
  const exclude = id ? { id, token: bearer(request) } : undefined;
  return json({ slots: await service.availability(from, to, zone, exclude, selectedEventId) });
}

async function publicBookingRoute(
  request: Request,
  dependencies: Dependencies,
  url: URL,
  service: BookingService,
  selectedEventId: string,
  ownerBookingId?: string,
  publicAction?: string
): Promise<Response | null> {
  const { env } = dependencies;
  const path = url.pathname;
  const method = request.method;
  if ((path === "/api/slots" || ownerBookingId || publicAction === "/slots") && method === "GET")
    return bookingSlots(request, dependencies, url, service, selectedEventId, ownerBookingId);
  if ((path === "/api/bookings" || publicAction === "/bookings") && method === "POST") {
    await limitAvailability(env.DB, request, (dependencies.now ?? Date.now)());
    await connectedOwner(env);
    const input = await body(request);
    await limitCreate(env.DB, request, input, (dependencies.now ?? Date.now)());
    return bookingResponse(await service.create(input, selectedEventId), true);
  }
  return attendeeBookingRoute(request, path, service);
}

async function attendeeBookingRoute(
  request: Request,
  path: string,
  service: BookingService
): Promise<Response | null> {
  const target = /^\/api\/bookings\/([a-z0-9-]{5,128})(\/retry)?$/.exec(path);
  if (!target) return null;
  const method = request.method;
  const id = target[1];
  const token = bearer(request);
  if (method === "GET" && !target[2]) return json(await service.view(id, token));
  if (method === "POST" && target[2]) return bookingResponse(await service.retry(id, token));
  if (method === "POST") return bookingResponse(await service.change(id, token, await body(request)));
  return json({ error: "not_found" }, 404);
}

export async function handleApi(request: Request, dependencies: Dependencies): Promise<Response> {
  const { env } = dependencies;
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/owner/events" || path.startsWith("/api/owner/events/")) {
    return ownerEvents(request, dependencies, url);
  }
  if (path === "/api/owner/schedules" || path.startsWith("/api/owner/schedules/"))
    return ownerSchedules(request, dependencies, url);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) sameOrigin(request, env.PUBLIC_ORIGIN);
  const auth = authRoute(request, env, path);
  if (auth) return auth;
  const publicEvent = await publicEventRoute(request, dependencies, url);
  if (publicEvent) return publicEvent;
  if (path === "/api/public" && request.method === "GET") return json(await getPublicBooking(env));
  const configuration = await ownerConfigurationRoute(request, dependencies, url);
  if (configuration) return configuration;
  const ownerSlots = /^\/api\/owner\/bookings\/([^/]+)\/slots$/.exec(path);
  if (ownerSlots) await owner(env, request);
  const ownerBooking = await ownerBookingRoute(request, dependencies, path);
  if (ownerBooking) return ownerBooking;
  if (path.startsWith("/api/owner")) await owner(env, request);
  const service = bookingService(dependencies);
  const mutation = await legacyOwnerMutation(request, env, path, service);
  if (mutation) return mutation;
  return (
    (await publicBookingRoute(request, dependencies, url, service, DEFAULT_EVENT_ID, ownerSlots?.[1])) ??
    json({ error: "not_found" }, 404)
  );
}

export { getPublicBooking, getPublicDirectory };
