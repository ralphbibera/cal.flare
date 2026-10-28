import common from "../../../../packages/i18n/locales/en/common.json" with { type: "json" };
import { isValidTimeZone, MAX_QUERY_DAYS } from "../domain/scheduling.ts";
import type { Settings } from "../domain/settings.ts";
import {
  parseBookingRules,
  parseEventDetails,
  parseScheduleOverrides,
  parseSettings,
  parseWeeklySchedule,
} from "../domain/settings.ts";
import type { AuthEnv } from "./auth.ts";
import { beginLogin, finishLogin, logout, requireOwner } from "./auth.ts";
import { BookingService } from "./bookings.ts";
import type { GoogleCalendar } from "./google.ts";
import { GoogleCalendar as CalendarClient } from "./google.ts";
import { bearer, body, ErrorWithCode, json, record, sameOrigin } from "./http.ts";
import { hash } from "./secrets.ts";
import {
  getSettings,
  saveBookingRules,
  saveEventDetails,
  saveScheduleOverrides,
  saveSettings,
  saveWeeklySchedule,
} from "./settings.ts";

type Dependencies = {
  env: AuthEnv;
  calendar?: Pick<GoogleCalendar, "busy" | "insert" | "get" | "update" | "delete">;
  now?: () => number;
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

async function getPublicBooking(env: AuthEnv) {
  const organizer = await connectedOwner(env);
  return { organizer, ...(await getSettings(env.DB)) };
}

function bookingResponse(value: Awaited<ReturnType<BookingService["view"]>>, created = false): Response {
  if (!["confirmed", "cancelled"].includes(value.status)) return json(value, 202);
  if (created) return json(value, 201);
  return json(value);
}

function bookingService(dependencies: Dependencies, settings: Settings): BookingService {
  return new BookingService({
    db: dependencies.env.DB,
    calendar: dependencies.calendar ?? new CalendarClient(dependencies.env),
    settings,
    secret: dependencies.env.TOKEN_ENCRYPTION_KEY,
    now: dependencies.now,
  });
}

export async function getOwnerData(request: Request, dependencies: Dependencies) {
  const identity = await requireOwner(dependencies.env, request);
  if (!identity) return null;
  const settings = await getSettings(dependencies.env.DB);
  return { owner: identity, settings, bookings: await bookingService(dependencies, settings).ownerList() };
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
  if (path === "/api/public" && method === "GET") return json(await getPublicBooking(env));
  if (path === "/api/owner" && method === "GET") {
    const data = await getOwnerData(request, dependencies);
    if (!data) throw new ErrorWithCode("unauthorized", 401);
    return json(data);
  }
  if (path === "/api/owner/schedule" && method === "PATCH") {
    await owner(env, request);
    await getSettings(env.DB);
    await saveWeeklySchedule(env.DB, parseWeeklySchedule(await body(request)));
    return json({ saved: true });
  }
  if (path === "/api/owner/overrides" && method === "PATCH") {
    await owner(env, request);
    await getSettings(env.DB);
    await saveScheduleOverrides(env.DB, parseScheduleOverrides(await body(request)));
    return json({ saved: true });
  }
  if (path === "/api/owner/booking-rules" && method === "PATCH") {
    await owner(env, request);
    await getSettings(env.DB);
    await saveBookingRules(env.DB, parseBookingRules(await body(request)));
    return json({ saved: true });
  }

  const settings = await getSettings(env.DB);
  const service = bookingService(dependencies, settings);
  if (path === "/api/owner") {
    await owner(env, request);
    if (method === "PUT") {
      await saveSettings(env.DB, parseSettings(await body(request)));
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
  if (path === "/api/slots" && method === "GET") {
    await limitAvailability(env.DB, request, (dependencies.now ?? Date.now)());
    await connectedOwner(env);
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
    const id = url.searchParams.get("bookingId");
    const exclude = id ? { id, token: bearer(request) } : undefined;
    return json({ slots: await service.availability(from, to, zone, exclude) });
  }
  if (path === "/api/bookings" && method === "POST") {
    await limitAvailability(env.DB, request, (dependencies.now ?? Date.now)());
    await connectedOwner(env);
    const input = await body(request);
    await limitCreate(env.DB, request, input, (dependencies.now ?? Date.now)());
    return bookingResponse(await service.create(input), true);
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
