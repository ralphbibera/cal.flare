import type { GetServerSidePropsContext, NextApiRequest } from "next";
import type { AuthOptions } from "next-auth";
import { getCalServerSession } from "./cal-session-cookie";

/**
 * Reads the session through the Better Auth server projection. `authOptions` is accepted
 * only so existing callers keep compiling; the signing secret comes from the bound request
 * auth environment.
 */
export async function getServerSession(options: {
  req: NextApiRequest | GetServerSidePropsContext["req"];
  authOptions?: AuthOptions;
}) {
  return getCalServerSession(options.req);
}
