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

// Prisma's D1 adapter rejects a statement over 98 bound values instead of splitting a long `in` list,
// so each chunk leaves room for the query's other parameters.
const IN_LIST_CHUNK_SIZE = 50;

export async function findManyInChunks<Value, Row>(
  values: readonly Value[],
  findMany: (chunk: Value[]) => Promise<Row[]>
): Promise<Row[]> {
  // A value repeated across two chunks would return its rows twice; one `in` list returns them once.
  const unique = Array.from(new Set(values));
  const chunks: Value[][] = [];
  for (let index = 0; index < unique.length; index += IN_LIST_CHUNK_SIZE) {
    chunks.push(unique.slice(index, index + IN_LIST_CHUNK_SIZE));
  }
  return (await Promise.all(chunks.map(findMany))).flat();
}
