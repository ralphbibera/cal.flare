import { getD1Database } from "@calcom/prisma/d1";

export async function getRuntimeConfigValue(key: string): Promise<unknown> {
  try {
    const row = await getD1Database()
      .prepare('SELECT "valueJson" FROM "RuntimeConfig" WHERE "key" = ?')
      .bind(key)
      .first<{ valueJson: string }>();
    if (!row) return undefined;
    return JSON.parse(row.valueJson);
  } catch {
    // A missing table, failed read, or malformed row must leave callers on their default.
    return undefined;
  }
}
