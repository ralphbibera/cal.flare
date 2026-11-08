import kysely from "@calcom/kysely";
import { compileD1Statement, requireD1RecordFor } from "@calcom/kysely/d1";
import { getD1Database } from "@calcom/prisma/d1";
import { runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import type { D1PreparedStatement } from "@cloudflare/workers-types";

type HostGroupWrite = { id: string; name: string };

// D1 allows 100 bound parameters per statement; a group row binds four and a delete binds its ids.
const HOST_GROUPS_PER_INSERT = 25;
const HOST_GROUPS_PER_DELETE = 100;

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

  for (let index = 0; index < groupsToCreate.length; index += HOST_GROUPS_PER_INSERT) {
    const rows = groupsToCreate.slice(index, index + HOST_GROUPS_PER_INSERT).map((group) => ({
      id: group.id,
      name: group.name,
      eventTypeId,
      updatedAt,
    }));
    statements.push(compileD1Statement(db, kysely.insertInto("HostGroup").values(rows)));
  }

  for (const group of groupsToUpdate) {
    statements.push(
      requireD1RecordFor(
        db,
        { modelName: "HostGroup", operation: "an update" },
        kysely.selectFrom("HostGroup").select("id").where("id", "=", group.id)
      ),
      compileD1Statement(
        db,
        kysely.updateTable("HostGroup").set({ name: group.name, updatedAt }).where("id", "=", group.id)
      )
    );
  }

  for (let index = 0; index < groupsToDelete.length; index += HOST_GROUPS_PER_DELETE) {
    const ids = groupsToDelete.slice(index, index + HOST_GROUPS_PER_DELETE).map((group) => group.id);
    statements.push(compileD1Statement(db, kysely.deleteFrom("HostGroup").where("id", "in", ids)));
  }

  if (statements.length === 0) return;
  await runD1Batch(db, statements, { modelName: "HostGroup" });
}
