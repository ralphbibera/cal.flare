import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { z } from "zod";
import { Prisma } from "./generated/prisma/client";
import { JsonValueSchema } from "./zod/inputTypeSchemas/JsonValueSchema";

const knownRequestError = (message: string, code: string, meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta,
  });

// Mirrors the codes and meta Prisma's D1 adapter reports, so callers keep their existing error handling.
function toPrismaError(error: Error, modelName: string) {
  const guard = /bad JSON path: 'calflare:(.*)'/.exec(error.message);
  if (guard) {
    const failure: D1GuardFailure = JSON.parse(guard[1]);
    if ("message" in failure) return new Error(failure.message);
    return knownRequestError(error.message, "P2025", failure);
  }
  const constraint = (kind: string, details: Record<string, unknown>) => ({
    modelName,
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: { originalMessage: error.message, kind, constraint: details },
    },
  });
  const columns = (match: RegExpExecArray) =>
    match[1].split(", ").map((column) => column.replace(/^.*\./, ""));
  const unique = /(?:UNIQUE|PRIMARY KEY) constraint failed: ([^:]+)/.exec(error.message);
  if (unique)
    return knownRequestError(
      error.message,
      "P2002",
      constraint("UniqueConstraintViolation", { fields: columns(unique) })
    );
  const notNull = /NOT NULL constraint failed: ([^:]+)/.exec(error.message);
  if (notNull)
    return knownRequestError(
      error.message,
      "P2011",
      constraint("NullConstraintViolation", { fields: columns(notNull) })
    );
  if (error.message.includes("FOREIGN KEY constraint failed"))
    return knownRequestError(
      error.message,
      "P2003",
      constraint("ForeignKeyConstraintViolation", { foreignKey: {} })
    );
  return error;
}

export type D1GuardFailure = { modelName: string; operation: "an update" | "a delete" } | { message: string };

export const toD1DateTime = (value: Date | string) => new Date(value).toISOString().replace("Z", "+00:00");

export const d1Boolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
export const d1DateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
export const d1Json = z
  .string()
  .transform((value): unknown => JSON.parse(value))
  .pipe(JsonValueSchema);

// Prisma generates `@default(uuid(7))` in its client, so native inserts supply the same time-ordered ids.
export function generateUuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < 6; index++) bytes[index] = Math.floor(now / 2 ** (8 * (5 - index))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// SQLite only raises from triggers, so a guard aborts its batch through an invalid JSON path that carries
// the failure; a zero-row write alone commits. A record failure maps to P2025, a message to a plain Error.
export function requireD1Record(
  db: D1Database,
  failure: D1GuardFailure,
  existsSql: string,
  ...bindings: unknown[]
): D1PreparedStatement {
  return db
    .prepare(`SELECT CASE WHEN EXISTS (${existsSql}) THEN 1 ELSE json_extract('{}', ?) END`)
    .bind(...bindings, `calflare:${JSON.stringify(failure)}`);
}

export async function runD1Batch(
  db: D1Database,
  statements: D1PreparedStatement[],
  { modelName }: { modelName: string }
): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw toPrismaError(error, modelName);
  }
}
