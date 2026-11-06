import type { PrismaClient } from "@calcom/prisma";
import { getD1Database } from "@calcom/prisma/d1";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";
import type { LocationObject } from "../locations";
import { getAppFromSlug } from "../utils";

export const bulkUpdateTeamEventsToDefaultLocation = async ({
  eventTypeIds,
  teamId,
  prisma,
}: {
  eventTypeIds: number[];
  teamId: number;
  prisma: PrismaClient;
}) => {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { metadata: true },
  });
  const metadataResult = teamMetadataSchema.safeParse(team?.metadata);
  const defaultApp = metadataResult.success ? metadataResult.data?.defaultConferencingApp : null;

  if (!defaultApp) {
    throw new Error("Default conferencing app not set");
  }

  const foundApp = getAppFromSlug(defaultApp.appSlug);
  const appType = foundApp?.appData?.location?.type;
  if (!appType) {
    throw new Error(`Default conferencing app '${defaultApp.appSlug}' doesnt exist.`);
  }

  const credential = await prisma.credential.findFirst({
    where: {
      teamId,
      appId: foundApp.slug,
    },
    select: {
      id: true,
    },
  });

  // One statement keeps the update atomic, and json_each keeps any number of event types within D1's bind limit.
  const locations: LocationObject[] = [
    { type: appType, link: defaultApp.appLink, credentialId: credential?.id },
  ];
  const result = await getD1Database()
    .prepare(
      `UPDATE "EventType" SET "locations" = ? WHERE "id" IN (SELECT value FROM json_each(?)) AND "teamId" = ?`
    )
    .bind(JSON.stringify(locations), JSON.stringify(eventTypeIds), teamId)
    .run();
  return { count: result.meta.changes };
};
