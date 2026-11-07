import type { GetServerSidePropsContext, NextApiRequest } from "next";
import { getCalServerSession } from "./cal-session-cookie";

/**
 * Reads the session through the Better Auth server projection. The signing secret comes from
 * the bound request auth environment.
 */
export async function getServerSession(options: { req: NextApiRequest | GetServerSidePropsContext["req"] }) {
  return getCalServerSession(options.req);
}
