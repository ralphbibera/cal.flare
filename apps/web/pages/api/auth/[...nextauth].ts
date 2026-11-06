import { handleCalAuth, routesToCalAuth } from "@calcom/features/auth/lib/cal-auth-dispatch";
import { getOptions } from "@calcom/features/auth/lib/next-auth-options";
import { getTrackingFromCookies } from "@calcom/lib/tracking";
import type { NextApiRequest, NextApiResponse } from "next";
import NextAuth from "next-auth";

// pass req to NextAuth: https://github.com/nextauthjs/next-auth/discussions/469
const handler = async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
  if (routesToCalAuth(req.query.nextauth) && (await handleCalAuth(req, res))) return;
  return NextAuth(
    req,
    res,
    getOptions({
      getDubId: () => req.cookies.dub_id || req.cookies.dclid,
      getTrackingData: () => getTrackingFromCookies(req.cookies, req.query),
    })
  );
};

export default handler;
