import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPlatformProxy } from "wrangler";
import type { Settings } from "../../src/domain/settings.ts";
import { defaultSettings } from "../../src/domain/settings.ts";
import { handleApi } from "../../src/server/app.ts";
import type { AuthEnv } from "../../src/server/auth.ts";
import type { CalendarEvent, EventInput } from "../../src/server/google.ts";
import { GoogleCalendarError } from "../../src/server/google.ts";
import { respond } from "../../src/server/http.ts";
import { encryptionKey, hash, randomSecret, seal } from "../../src/server/secrets.ts";
import { saveSettings } from "../../src/server/settings.ts";

export const hour = 3_600_000;
export function storedSettings(db: D1Database) {
  return db
    .prepare(`SELECT '{"event":'||e.json||',"schedule":'||s.json||CASE WHEN o.json='{}' THEN '}' ELSE ','||substr(o.json,2) END AS json,
    e.version+o.version+s.version AS version FROM event_type e JOIN organizer_settings o ON o.id='owner'
    JOIN availability_schedule s ON s.id=COALESCE(e.schedule_id,o.default_schedule_id)
    WHERE e.id='default'`)
    .first<{ json: string; version: number }>();
}
export const settings: Settings = {
  ...defaultSettings,
  event: {
    ...defaultSettings.event,
    description: "Meet the organizer",
    intervalMinutes: 5,
    noticeMinutes: 0,
  },
  schedule: {
    timeZone: "UTC",
    rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
  },
};

export class FakeCalendar {
  readonly events = new Map<string, CalendarEvent>();
  readonly writes: { action: string; id: string; etag?: string; attendee?: string }[] = [];
  cutAfter: "insert" | "update" | "delete" | undefined;
  private revision = 0;

  async busy(from: string, to: string, exclude?: string, conflictCalendarIds?: string[]) {
    if (conflictCalendarIds && !conflictCalendarIds.includes("primary")) return [];
    return [...this.events.values()].flatMap((event) => {
      assert.ok("dateTime" in event.start && "dateTime" in event.end);
      const start = Date.parse(event.start.dateTime),
        end = Date.parse(event.end.dateTime);
      const owned =
        event.extendedProperties?.private?.application === "calflare" &&
        event.extendedProperties?.private?.booking === event.id;
      return !(event.id === exclude && owned) && start < Date.parse(to) && end > Date.parse(from)
        ? [{ start, end }]
        : [];
    });
  }

  private event(input: EventInput): CalendarEvent {
    assert.match(input.id, /^[0-9a-v]{5,1024}$/);
    assert.equal(input.privateMetadata.application, "calflare");
    assert.equal(input.privateMetadata.booking, input.id);
    assert.ok(input.privateMetadata.operation);
    return {
      id: input.id,
      etag: `"fixture-${++this.revision}"`,
      start: { dateTime: new Date(input.start).toISOString() },
      end: { dateTime: new Date(input.end).toISOString() },
      summary: input.title,
      description: input.description,
      ...(input.location === undefined ? {} : { location: input.location }),
      attendees: [
        { email: input.attendee.email, displayName: input.attendee.name },
        ...(input.guests ?? []).map((email) => ({ email })),
      ],
      extendedProperties: { private: { ...input.privateMetadata } },
    };
  }

  private cut(action: "insert" | "update" | "delete") {
    if (this.cutAfter !== action) return;
    this.cutAfter = undefined;
    throw new GoogleCalendarError("ambiguous", 0, "Fixture response cut after remote apply");
  }

  async insert(input: EventInput) {
    if (this.events.has(input.id)) throw new GoogleCalendarError("definite", 409, "Duplicate event");
    const event = this.event(input);
    this.events.set(input.id, event);
    this.writes.push({ action: "insert", id: input.id, attendee: input.attendee.email });
    this.cut("insert");
    return { id: event.id, etag: event.etag };
  }

  async get(id: string) {
    return structuredClone(this.events.get(id) ?? null);
  }

  private match(id: string, etag: string) {
    if (this.events.get(id)?.etag !== etag) throw new GoogleCalendarError("definite", 412, "Stale ETag");
  }

  async update(id: string, etag: string, input: Omit<EventInput, "id">) {
    this.match(id, etag);
    const previous = this.events.get(id);
    const event = this.event({ ...input, id });
    if (input.location === undefined && previous?.location !== undefined) event.location = previous.location;
    this.events.set(id, event);
    this.writes.push({ action: "update", id, etag, attendee: input.attendee.email });
    this.cut("update");
    return { id, etag: event.etag };
  }

  async delete(id: string, etag: string) {
    this.match(id, etag);
    this.events.delete(id);
    this.writes.push({ action: "delete", id, etag });
    this.cut("delete");
  }
}

export async function apiFixture({
  port = 0,
  legacyEvents = false,
  legacyLifecycle = false,
  legacySchedules = false,
  legacyProfile = false,
}: {
  port?: number;
  legacyEvents?: boolean;
  legacyLifecycle?: boolean;
  legacySchedules?: boolean;
  legacyProfile?: boolean;
} = {}) {
  const configPath = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const temporary = await mkdtemp(join(tmpdir(), "flare-http-"));
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  const server = createServer();
  const close = async () => {
    try {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    } finally {
      try {
        await platform?.dispose();
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  };
  try {
    const migrate = async (name: string) => {
      await promisify(execFile)(process.execPath, [
        wrangler,
        "d1",
        "execute",
        "calflare",
        "--local",
        "--persist-to",
        temporary,
        "--file",
        fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
        "--config",
        configPath,
      ]);
    };
    for (const name of [
      "0001_identity.sql",
      "0002_settings.sql",
      "0003_bookings.sql",
      "0004_http.sql",
      ...(legacyEvents ? [] : ["0005_events.sql"]),
      ...(legacyEvents || legacyLifecycle ? [] : ["0006_event_lifecycle.sql"]),
      ...(legacyEvents || legacyLifecycle || legacySchedules ? [] : ["0007_availability_schedules.sql"]),
      ...(legacyProfile ? [] : ["0008_public_profile.sql"]),
    ])
      await migrate(name);
    const connect = () =>
      getPlatformProxy<{ DB: D1Database }>({
        configPath,
        persist: { path: join(temporary, "v3") },
        remoteBindings: false,
      });
    platform = await connect();
    let db = platform.env.DB;
    const calendar = new FakeCalendar();
    const clock = Date.UTC(2030, 0, 1);
    const env: AuthEnv = {
      DB: db,
      PUBLIC_ORIGIN: "http://127.0.0.1",
      GOOGLE_CLIENT_ID: randomSecret(),
      GOOGLE_CLIENT_SECRET: randomSecret(),
      GOOGLE_OWNER_EMAIL: "owner@example.test",
      TOKEN_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    };
    const session = randomSecret();
    const ciphertext = await seal(
      await encryptionKey(env.TOKEN_ENCRYPTION_KEY),
      JSON.stringify({
        access: randomSecret(),
        refresh: randomSecret(),
        expiresAt: Date.now() + hour,
      }),
      "google:owner"
    );
    await db.batch([
      db
        .prepare("INSERT INTO owner VALUES ('owner', ?, ?, ?)")
        .bind("fixture-google-subject", env.GOOGLE_OWNER_EMAIL, "Organizer"),
      db.prepare("INSERT INTO google_connection VALUES ('owner', ?, 1)").bind(ciphertext),
      db
        .prepare("INSERT INTO owner_session VALUES (?, 'owner', ?)")
        .bind(await hash(session), Date.now() + hour),
    ]);
    if (legacyEvents)
      await db
        .prepare("INSERT INTO organizer_settings VALUES ('owner',?,1)")
        .bind(JSON.stringify(settings))
        .run();
    else if (legacyLifecycle || legacySchedules) {
      const { event, ...preferences } = settings;
      await db.batch([
        db.prepare("UPDATE event_type SET json=? WHERE id='default'").bind(JSON.stringify(event)),
        db.prepare("UPDATE organizer_settings SET json=? WHERE id='owner'").bind(JSON.stringify(preferences)),
      ]);
    } else await saveSettings(db, settings);
    const migrateEvents = async (lifecycle = false) => {
      await platform?.dispose();
      try {
        await migrate(lifecycle ? "0006_event_lifecycle.sql" : "0005_events.sql");
      } finally {
        platform = await connect();
        db = platform.env.DB;
        env.DB = db;
      }
    };
    const migrateSchedules = async () => {
      await platform?.dispose();
      try {
        await migrate("0007_availability_schedules.sql");
      } finally {
        platform = await connect();
        db = platform.env.DB;
        env.DB = db;
      }
    };
    const migrateProfile = async () => {
      await platform?.dispose();
      try {
        await migrate("0008_public_profile.sql");
      } finally {
        platform = await connect();
        db = platform.env.DB;
        env.DB = db;
      }
    };
    server.on("request", async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const request = new Request(new URL(incoming.url ?? "/", env.PUBLIC_ORIGIN), {
          method: incoming.method,
          headers,
          ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: Buffer.concat(chunks) }),
        });
        const response = await respond(request, () =>
          handleApi(request, { env, calendar, now: () => clock })
        );
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.destroy(error instanceof Error ? error : new Error("Fixture bridge failed"));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    env.PUBLIC_ORIGIN = `http://127.0.0.1:${address.port}`;
    const request = (path: string, init: RequestInit = {}) => fetch(`${env.PUBLIC_ORIGIN}${path}`, init);
    const send = (path: string, value: unknown, extra: Record<string, string> = {}, method = "POST") =>
      request(path, {
        method,
        headers: { Origin: env.PUBLIC_ORIGIN, "Content-Type": "application/json", ...extra },
        body: JSON.stringify(value),
      });
    return {
      get db() {
        return db;
      },
      migrateEvents,
      migrateSchedules,
      migrateProfile,
      calendar,
      env,
      ciphertext,
      session,
      request,
      send,
      close,
      ownerHeaders: { Cookie: `flare_session=${session}` },
      now: () => clock,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
