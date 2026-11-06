import { getD1Database } from "@calcom/prisma/d1";
import { unstable_cache } from "next/cache";
import { z } from "zod";

const computeInstallCountsFromDB = async (): Promise<Record<string, number>> => {
  const { results } = await getD1Database()
    .prepare(`
    SELECT
      c."appId",
      COUNT(*) AS "installCount"
    FROM
      "Credential" c
    WHERE
      c."appId" IS NOT NULL
    GROUP BY
      c."appId"
    ORDER BY
      "installCount" DESC
    `)
    .all();
  const mostPopularApps = z.array(z.object({ appId: z.string(), installCount: z.number() })).parse(results);
  return mostPopularApps.reduce<Record<string, number>>((acc, { appId, installCount }) => {
    acc[appId] = installCount;
    return acc;
  }, {});
};

const getInstallCountPerApp = async (): Promise<Record<string, number>> => {
  return unstable_cache(async () => computeInstallCountsFromDB(), ["app-install-counts"], {
    revalidate: 300,
    tags: ["app-install-counts"],
  })();
};

export default getInstallCountPerApp;
export { computeInstallCountsFromDB };
