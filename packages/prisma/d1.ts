import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { D1Database } from "@cloudflare/workers-types";

export type D1Environment = { DB: D1Database };

export type D1RequestScope = { readonly database: D1Database };

const storageKey = Symbol.for("calflare.d1.request-storage");
const shared = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<D1RequestScope>;
};
// Vinext evaluates server modules separately for RSC and Pages/SSR.
const scope = (shared[storageKey] ??= new AsyncLocalStorage<D1RequestScope>());

export function withD1Database<T>(env: D1Environment, callback: () => T): T {
  // The worker entry and the auth wrapper both bind the same request; a nested bind
  // must not restart the scope, or request-scoped clients would be recreated mid-request.
  if (scope.getStore()?.database === env.DB) return callback();
  return scope.run({ database: env.DB }, callback);
}

export function getD1Database(): D1Database {
  const database = scope.getStore()?.database;
  if (!database) throw new ErrorWithCode(ErrorCode.InternalServerError, "D1 request binding is required");
  return database;
}

/** Stable identity for the current request, used to key request-scoped clients. */
export function getD1RequestScope(): D1RequestScope {
  const current = scope.getStore();
  if (!current) throw new ErrorWithCode(ErrorCode.InternalServerError, "D1 request binding is required");
  return current;
}

// Prisma's D1 adapter rejects a statement over 98 bound values instead of splitting a long `in` list,
// so each chunk leaves room for the query's other parameters.
export const D1_IN_LIST_CHUNK_SIZE = 50;

export async function findManyInChunks<Value, Row>(
  values: readonly Value[],
  findMany: (chunk: Value[]) => Promise<Row[]>,
  chunkSize = D1_IN_LIST_CHUNK_SIZE
): Promise<Row[]> {
  // A value repeated across two chunks would return its rows twice; one `in` list returns them once.
  const unique = Array.from(new Set(values));
  const chunks: Value[][] = [];
  for (let index = 0; index < unique.length; index += chunkSize) {
    chunks.push(unique.slice(index, index + chunkSize));
  }
  return (await Promise.all(chunks.map(findMany))).flat();
}
