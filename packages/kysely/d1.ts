import type { D1GuardFailure } from "@calcom/prisma/d1-batch";
import { requireD1Record } from "@calcom/prisma/d1-batch";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Compilable } from "kysely";

// Kysely's compile step produces the same sql and parameters its D1 connection would run, so a typed
// query can join a native batch without executing on its own.
export function compileD1Statement(db: D1Database, query: Compilable): D1PreparedStatement {
  const { sql, parameters } = query.compile();
  return db.prepare(sql).bind(...parameters);
}

export function requireD1RecordFor(
  db: D1Database,
  failure: D1GuardFailure,
  query: Compilable
): D1PreparedStatement {
  const { sql, parameters } = query.compile();
  return requireD1Record(db, failure, sql, ...parameters);
}
