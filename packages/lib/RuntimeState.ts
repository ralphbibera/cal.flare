type SqlValue = string | number | null;

type RuntimeStateContext = {
  storage: {
    sql: {
      exec<Row extends Record<string, SqlValue>>(
        query: string,
        ...bindings: SqlValue[]
      ): { toArray(): Row[] };
    };
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
  };
};

type RateLimitRequest = {
  identifier: string;
  limit: number;
  duration: number;
  cost: number;
};

type RedisRequest =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string; ttl?: number }
  | { op: "del"; key: string }
  | { op: "expire"; key: string; seconds: number }
  | { op: "lrange"; key: string; start: number; end: number }
  | { op: "lpush"; key: string; values: string[] };

type RedisResult = { value: unknown; expiresAt: number | null };

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";
const isCount = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum;

function isRateLimitRequest(body: unknown): body is RateLimitRequest {
  const { identifier, limit, duration, cost } = (body ?? {}) as Partial<RateLimitRequest>;
  return typeof identifier === "string" && isCount(limit, 0) && isCount(duration, 1) && isCount(cost, 0);
}

function isRedisRequest(body: unknown): body is RedisRequest {
  if (!body || typeof body !== "object") return false;
  const { op, key } = body as { op?: unknown; key?: unknown };
  if (typeof key !== "string" || key.length === 0) return false;

  switch (op) {
    case "get":
    case "del":
      return true;
    case "set": {
      const { value, ttl } = body as { value?: unknown; ttl?: unknown };
      return typeof value === "string" && (ttl === undefined || isCount(ttl, 1));
    }
    case "expire":
      return Number.isSafeInteger((body as { seconds?: unknown }).seconds);
    case "lrange": {
      const { start, end } = body as { start?: unknown; end?: unknown };
      return Number.isSafeInteger(start) && Number.isSafeInteger(end);
    }
    case "lpush": {
      const { values } = body as { values?: unknown };
      return Array.isArray(values) && values.every((value) => typeof value === "string");
    }
    default:
      return false;
  }
}

// Plain class with fetch because extending DurableObject would import cloudflare:workers
// into @calcom/lib, which is also evaluated outside Workers.
export class RuntimeState {
  constructor(private readonly ctx: RuntimeStateContext) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_window (
        identifier TEXT NOT NULL,
        duration INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (identifier, duration, sequence)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS rate_limit_window_expires_at ON rate_limit_window (expires_at);
      CREATE TABLE IF NOT EXISTS cache_entry (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS cache_entry_expires_at ON cache_entry (expires_at);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/redis") return this.redis(request);
    return this.rateLimit(request);
  }

  async alarm(): Promise<void> {
    const { sql } = this.ctx.storage;
    const now = Date.now();
    sql.exec("DELETE FROM rate_limit_window WHERE expires_at <= ?", now);
    sql.exec("DELETE FROM cache_entry WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
    const [rateLimit] = sql
      .exec<{ expires_at: number | null }>("SELECT MIN(expires_at) AS expires_at FROM rate_limit_window")
      .toArray();
    const [cache] = sql
      .exec<{ expires_at: number | null }>(
        "SELECT MIN(expires_at) AS expires_at FROM cache_entry WHERE expires_at IS NOT NULL"
      )
      .toArray();
    const next = Math.min(
      rateLimit?.expires_at ?? Number.POSITIVE_INFINITY,
      cache?.expires_at ?? Number.POSITIVE_INFINITY
    );
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  private async rateLimit(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    if (!isRateLimitRequest(body)) return new Response(null, { status: 400 });

    const { response, expiresAt } = this.consume(body);
    if (expiresAt !== null) await this.scheduleAlarm(expiresAt);
    return Response.json(response);
  }

  private async redis(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    if (!isRedisRequest(body)) return Response.json({ error: "Invalid redis command" }, { status: 400 });

    try {
      const { value, expiresAt } = this.execute(body);
      if (expiresAt !== null) await this.scheduleAlarm(expiresAt);
      return Response.json({ result: value });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Redis command failed" },
        { status: 400 }
      );
    }
  }

  private async scheduleAlarm(expiresAt: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
  }

  // Must stay synchronous: with no await between the read and the upsert, concurrent
  // requests to this object cannot interleave and over-admit.
  private consume({ identifier, limit, duration, cost }: RateLimitRequest) {
    const { sql } = this.ctx.storage;
    const now = Date.now();
    const sequence = Math.floor(now / duration);
    const reset = (sequence + 1) * duration;

    const counts = new Map(
      sql
        .exec<{ sequence: number; count: number }>(
          "SELECT sequence, count FROM rate_limit_window WHERE identifier = ? AND duration = ? AND sequence IN (?, ?)",
          identifier,
          duration,
          sequence,
          sequence - 1
        )
        .toArray()
        .map((row) => [row.sequence, row.count])
    );
    // Sliding window over fixed cells: the previous cell counts for the share of it that
    // still overlaps a window ending now, so a cell boundary cannot admit a double burst.
    const previousShare = (reset - now) / duration;
    const used = (counts.get(sequence) ?? 0) + (counts.get(sequence - 1) ?? 0) * previousShare;

    if (used + cost > limit) {
      return { response: { success: false, limit, remaining: 0, reset }, expiresAt: null };
    }

    // The cell is still read as the previous cell throughout the following window.
    const expiresAt = reset + duration;
    sql.exec(
      `INSERT INTO rate_limit_window (identifier, duration, sequence, count, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (identifier, duration, sequence) DO UPDATE SET count = count + excluded.count`,
      identifier,
      duration,
      sequence,
      cost,
      expiresAt
    );
    return {
      response: { success: true, limit, remaining: Math.floor(limit - used - cost), reset },
      expiresAt,
    };
  }

  // Redis commands stay synchronous so a command's read and write cannot interleave
  // with another command on the same Durable Object.
  private execute(command: RedisRequest): RedisResult {
    switch (command.op) {
      case "get":
        return { value: this.readString(command.key), expiresAt: null };
      case "set":
        return this.writeString(command.key, command.value, command.ttl);
      case "del":
        return { value: this.deleteKey(command.key), expiresAt: null };
      case "expire":
        return this.expireKey(command.key, command.seconds);
      case "lrange":
        return { value: this.readList(command.key, command.start, command.end), expiresAt: null };
      case "lpush":
        return this.pushList(command.key, command.values);
    }
  }

  private readString(key: string): string | null {
    const entry = this.readEntry(key);
    if (entry?.kind === "list") throw new Error(WRONGTYPE);
    return entry?.value ?? null;
  }

  private writeString(key: string, value: string, ttl?: number): RedisResult {
    const expiresAt = ttl === undefined ? null : Date.now() + ttl;
    this.writeEntry(key, "string", value, expiresAt);
    return { value: "OK", expiresAt };
  }

  private deleteKey(key: string): number {
    if (!this.readEntry(key)) return 0;
    this.purge(key);
    return 1;
  }

  private expireKey(key: string, seconds: number): RedisResult {
    if (!this.readEntry(key)) return { value: 0, expiresAt: null };
    if (seconds <= 0) {
      this.purge(key);
      return { value: 1, expiresAt: null };
    }
    const expiresAt = Date.now() + seconds * 1000;
    this.ctx.storage.sql.exec("UPDATE cache_entry SET expires_at = ? WHERE key = ?", expiresAt, key);
    return { value: 1, expiresAt };
  }

  private readList(key: string, start: number, end: number): string[] {
    const entry = this.readEntry(key);
    if (entry?.kind === "string") throw new Error(WRONGTYPE);
    const values = entry ? (JSON.parse(entry.value) as string[]) : [];
    let from = start < 0 ? values.length + start : start;
    let to = end < 0 ? values.length + end : end;
    if (from < 0) from = 0;
    if (to >= values.length) to = values.length - 1;
    if (from > to || from >= values.length) return [];
    return values.slice(from, to + 1);
  }

  private pushList(key: string, values: string[]): RedisResult {
    if (values.length === 0) throw new Error("LPUSH requires at least one element");

    const entry = this.readEntry(key);
    if (entry?.kind === "string") throw new Error(WRONGTYPE);

    const list = entry ? (JSON.parse(entry.value) as string[]) : [];
    for (const value of values) list.unshift(value);
    this.writeEntry(key, "list", JSON.stringify(list), entry?.expiresAt ?? null);
    return { value: list.length, expiresAt: null };
  }

  private readEntry(key: string): { kind: string; value: string; expiresAt: number | null } | null {
    const [entry] = this.ctx.storage.sql
      .exec<{ kind: string; value: string; expires_at: number | null }>(
        "SELECT kind, value, expires_at FROM cache_entry WHERE key = ?",
        key
      )
      .toArray();
    if (!entry) return null;
    if (entry.expires_at !== null && entry.expires_at <= Date.now()) {
      this.purge(key);
      return null;
    }
    return { kind: entry.kind, value: entry.value, expiresAt: entry.expires_at };
  }

  private writeEntry(key: string, kind: "string" | "list", value: string, expiresAt: number | null): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO cache_entry (key, kind, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, value = excluded.value, expires_at = excluded.expires_at",
      key,
      kind,
      value,
      expiresAt
    );
  }

  private purge(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM cache_entry WHERE key = ?", key);
  }
}

export type { RateLimitRequest, RedisRequest };
