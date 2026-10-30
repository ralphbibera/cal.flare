import common from "../../../../packages/i18n/locales/en/common.json" with { type: "json" };
import { isValidTimeZone, MAX_QUERY_DAYS } from "../domain/scheduling.ts";
import type { Settings } from "../domain/settings.ts";
import {
  defaultSettings,
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
import { hash } from "./secrets.ts";
import {
  createEvent,
  DEFAULT_EVENT_ID,
  duplicateEvent,
  eventId,
  getBookableSettings,
  getOwnerEvent,
  getOwnerPreferences,
  getSettings,
  listEvents,
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
  if (url.search) throw new ErrorWithCode("invalid_query");
  const method = request.method;
  if (url.pathname === "/api/owner/events") {
    if (method === "GET") return json({ events: await listEvents(env.DB) });
    if (method === "POST")
      return json(await createEvent(env.DB, parseEventDetails(await body(request))), 201);
    return json({ error: "not_found" }, 404);
  }
  const target = /^\/api\/owner\/events\/([^/]+)(\/(?:booking-rules|duplicate|visibility))?$/.exec(
    url.pathname
  );
  if (!target) throw new ErrorWithCode("not_found", 404);
  const id = eventId(target[1]);
  const lifecycle = await eventLifecycle(request, env.DB, id, target[2]);
  if (lifecycle) return lifecycle;
  const selected = await getOwnerEvent(env.DB, id);
  if (method === "GET" && !target[2]) return json(selected);
  if (method !== "PATCH") return json({ error: "not_found" }, 404);
  const input = await body(request);
  if (target[2] === "/booking-rules") await saveBookingRules(env.DB, parseBookingRules(input), id);
  else if (target[2]) return json({ error: "not_found" }, 404);
  else await saveEventDetails(env.DB, parseEventDetails(input), id);
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
  if (
    ids.length > 1 ||
    modes.length > 1 ||
    (ids.length && modes.length) ||
    (modes.length && modes[0] !== "1")
  )
    throw new ErrorWithCode("invalid_query");
  const events = await listEvents(dependencies.env.DB);
  const selectedId = eventId(ids[0] ?? events[0]?.id ?? DEFAULT_EVENT_ID);
  const creating = modes.length === 1 || (!ids.length && events.length === 0);
  const preferences = await getOwnerPreferences(dependencies.env.DB);
  const settings = {
    ...preferences,
    event: creating ? defaultSettings.event : (await getOwnerEvent(dependencies.env.DB, selectedId)).event,
  };
  return {
    owner: identity,
    settings,
    selectedId,
    creating,
    events,
    bookings: await bookingService(dependencies).ownerList(),
  };
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

export async function handleApi(request: Request, dependencies: Dependencies): Promise<Response> {
  const { env } = dependencies;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) sameOrigin(request, env.PUBLIC_ORIGIN);
  if (path === "/api/auth/login" && method === "GET") return beginLogin(env, request);
  if (path === "/api/auth/callback" && method === "GET") return finishLogin(env, request);
  if (path === "/api/auth/logout" && method === "POST") return logout(env, request);
  if (path === "/api/owner/events" || path.startsWith("/api/owner/events/")) {
    return ownerEvents(request, dependencies, url);
  }
  const publicTarget = /^\/api\/events\/([^/]+)(\/(?:slots|bookings))?$/.exec(path);
  const selectedEventId = publicTarget ? eventId(publicTarget[1]) : DEFAULT_EVENT_ID;
  if (publicTarget) {
    if (!publicTarget[2] && method === "GET") {
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
    const allowed = publicTarget[2] === "/slots" ? ["from", "to", "timeZone"] : [];
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
        throw new ErrorWithCode("invalid_query");
    }
  }
  if (path === "/api/public" && method === "GET") return json(await getPublicBooking(env));
  if (path === "/api/owner" && method === "GET") {
    const data = await getOwnerData(request, dependencies);
    if (!data) throw new ErrorWithCode("unauthorized", 401);
    return json(data);
  }
  if (path === "/api/owner/conflict-calendars") {
    await owner(env, request);
    if (url.search) throw new ErrorWithCode("invalid_query");
    if (method === "GET")
      return json({
        calendars: await new CalendarClient(env).listCalendars(),
        conflictCalendarIds: (await getOwnerPreferences(env.DB)).conflictCalendarIds ?? null,
      });
    if (method === "PATCH") {
      await getOwnerPreferences(env.DB);
      const ids = parseConflictCalendars(await body(request));
      await validateConflictCalendars(env, ids);
      await saveConflictCalendars(env.DB, ids);
      return json({ saved: true });
    }
    return json({ error: "not_found" }, 404);
  }
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
  const ownerSlots = /^\/api\/owner\/bookings\/([^/]+)\/slots$/.exec(path);
  if (ownerSlots) await owner(env, request);
  const ownerBooking = /^\/api\/owner\/bookings\/([^/]+)$/.exec(path);
  if (ownerBooking) {
    await owner(env, request);
    const service = bookingService(dependencies);
    if (method === "GET") return json(await service.ownerView(ownerBooking[1]));
    if (method === "POST")
      return bookingResponse(await service.ownerChange(ownerBooking[1], await body(request)));
    return json({ error: "not_found" }, 404);
  }

  if (path.startsWith("/api/owner")) await owner(env, request);
  const service = bookingService(dependencies);
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
  }
  if (path === "/api/owner/retry" && method === "POST") {
    await owner(env, request);
    const input = record(await body(request));
    if (typeof input.id !== "string") throw new ErrorWithCode("invalid_booking");
    return bookingResponse(await service.ownerRetry(input.id));
  }
  if ((path === "/api/slots" || ownerSlots || publicTarget?.[2] === "/slots") && method === "GET") {
    await limitAvailability(env.DB, request, (dependencies.now ?? Date.now)());
    await connectedOwner(env);
    if (ownerSlots) {
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
    if (ownerSlots) return json({ slots: await service.ownerAvailability(ownerSlots[1], from, to, zone) });
    const id = url.searchParams.get("bookingId");
    const exclude = id ? { id, token: bearer(request) } : undefined;
    return json({ slots: await service.availability(from, to, zone, exclude, selectedEventId) });
  }
  if ((path === "/api/bookings" || publicTarget?.[2] === "/bookings") && method === "POST") {
    await limitAvailability(env.DB, request, (dependencies.now ?? Date.now)());
    await connectedOwner(env);
    const input = await body(request);
    await limitCreate(env.DB, request, input, (dependencies.now ?? Date.now)());
    return bookingResponse(await service.create(input, selectedEventId), true);
  }
  const target = /^\/api\/bookings\/([a-z0-9-]{5,128})(\/retry)?$/.exec(path);
  if (target) {
    const id = target[1];
    const token = bearer(request);
    if (method === "GET" && !target[2]) return json(await service.view(id, token));
    if (method === "POST" && target[2]) return bookingResponse(await service.retry(id, token));
    if (method === "POST") return bookingResponse(await service.change(id, token, await body(request)));
  }
  return json({ error: "not_found" }, 404);
}

export { getPublicBooking };
