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

export type RateLimitRequest = {
  identifier: string;
  limit: number;
  duration: number;
  cost: number;
};

const isCount = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum;

function isRateLimitRequest(body: unknown): body is RateLimitRequest {
  const { identifier, limit, duration, cost } = (body ?? {}) as Partial<RateLimitRequest>;
  return typeof identifier === "string" && isCount(limit, 0) && isCount(duration, 1) && isCount(cost, 0);
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
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    if (!isRateLimitRequest(body)) return new Response(null, { status: 400 });

    const { response, expiresAt } = this.consume(body);
    if (expiresAt !== null) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    }
    return Response.json(response);
  }

  async alarm(): Promise<void> {
    const { sql } = this.ctx.storage;
    sql.exec("DELETE FROM rate_limit_window WHERE expires_at <= ?", Date.now());
    const [next] = sql
      .exec<{ expires_at: number | null }>("SELECT MIN(expires_at) AS expires_at FROM rate_limit_window")
      .toArray();
    if (next?.expires_at != null) await this.ctx.storage.setAlarm(next.expires_at);
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
}
