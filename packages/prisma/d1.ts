import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { D1Database } from "@cloudflare/workers-types";

export type D1Environment = { DB: D1Database };

const storageKey = Symbol.for("calflare.d1.request-storage");
const shared = globalThis as typeof globalThis & { [storageKey]?: AsyncLocalStorage<D1Database> };
// Vinext evaluates server modules separately for RSC and Pages/SSR.
const database = (shared[storageKey] ??= new AsyncLocalStorage<D1Database>());

export function withD1Database<T>(env: D1Environment, callback: () => T): T {
  return database.run(env.DB, callback);
}

export function getD1Database(): D1Database {
  const db = database.getStore();
  if (!db) throw new ErrorWithCode(ErrorCode.InternalServerError, "D1 request binding is required");
  return db;
}
