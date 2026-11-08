import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import type { D1PreparedStatement } from "@cloudflare/workers-types";

type HostGroupWrite = { id: string; name: string };

// Prisma's interactive transaction runs each call as its own D1 query, so the group rows must share one
// batch. Deleting a group also nulls its Host.groupId through the foreign key inside that batch.
export async function writeEventTypeHostGroupsInD1({
  eventTypeId,
  groupsToCreate,
  groupsToUpdate,
  groupsToDelete,
}: {
  eventTypeId: number;
  groupsToCreate: HostGroupWrite[];
  groupsToUpdate: HostGroupWrite[];
  groupsToDelete: { id: string }[];
}): Promise<void> {
  const db = getD1Database();
  const updatedAt = toD1DateTime(new Date());
  const statements: D1PreparedStatement[] = [];

  if (groupsToCreate.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO "HostGroup" ("id", "name", "eventTypeId", "updatedAt")
           SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), ?, ?
           FROM json_each(?)`
        )
        .bind(eventTypeId, updatedAt, JSON.stringify(groupsToCreate))
    );
  }

  for (const group of groupsToUpdate) {
    statements.push(
      requireD1Record(
        db,
        { modelName: "HostGroup", operation: "an update" },
        'SELECT 1 FROM "HostGroup" WHERE "id" = ?',
        group.id
      ),
      db
        .prepare('UPDATE "HostGroup" SET "name" = ?, "updatedAt" = ? WHERE "id" = ?')
        .bind(group.name, updatedAt, group.id)
    );
  }

  if (groupsToDelete.length > 0) {
    statements.push(
      db
        .prepare('DELETE FROM "HostGroup" WHERE "id" IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(groupsToDelete.map((group) => group.id)))
    );
  }

  if (statements.length === 0) return;
  await runD1Batch(db, statements, { modelName: "HostGroup" });
}
