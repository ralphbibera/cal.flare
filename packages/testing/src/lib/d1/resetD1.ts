import type { D1Database } from "@cloudflare/workers-types";

/** Reference rows created by migrations, not by a test scenario. */
const MIGRATION_SEEDED_TABLES = new Set([
  "AuditActor",
  "Feature",
  "OutOfOfficeReason",
  "Role",
  "RolePermission",
  "RuntimeConfig",
]);

type SqliteRow = Record<string, unknown>;

async function tableNames(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`
    )
    .all<SqliteRow>();
  return result.results.map((row) => String(row.name));
}

/**
 * Builds a child-before-parent delete order. Foreign keys are enforced by D1, and tests seed
 * every table through Prisma, so the reset cannot assume insertion order matches the graph.
 */
async function deletionOrder(db: D1Database, tables: string[]) {
  const references = new Map<string, Set<string>>();
  for (const table of tables) {
    const foreignKeys = await db.prepare(`PRAGMA foreign_key_list("${table}")`).all<SqliteRow>();
    const parents = new Set<string>();
    for (const key of foreignKeys.results) {
      const parent = String(key.table);
      if (parent !== table && tables.includes(parent)) parents.add(parent);
    }
    references.set(table, parents);
  }

  const order: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size) {
    const leaves = Array.from(remaining).filter(
      (table) => !Array.from(remaining).some((other) => other !== table && references.get(other)?.has(table))
    );
    if (!leaves.length) {
      // A reference cycle between unrelated tables cannot be ordered; the batch defers the checks.
      order.push(...Array.from(remaining));
      break;
    }
    for (const table of leaves) {
      order.push(table);
      remaining.delete(table);
    }
  }
  return order;
}

export async function resetD1Database(db: D1Database) {
  const tables = (await tableNames(db)).filter((table) => !MIGRATION_SEEDED_TABLES.has(table));
  const order = await deletionOrder(db, tables);
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...order.map((table) => db.prepare(`DELETE FROM "${table}"`)),
    db.prepare("DELETE FROM sqlite_sequence"),
  ]);
}
