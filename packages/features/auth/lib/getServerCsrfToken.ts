import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { GetServerSidePropsContext } from "next";
import { createCalCsrfState } from "./cal-csrf";
import { getAuthRequestEnvironment } from "./request-context";

export async function getServerCsrfToken(
  req: Pick<GetServerSidePropsContext["req"], "cookies">
): Promise<string> {
  const { NEXTAUTH_SECRET: secret } = getAuthRequestEnvironment();
  if (!secret?.trim())
    throw new ErrorWithCode(ErrorCode.InternalServerError, "NEXTAUTH_SECRET is required for auth");
  const prefix = WEBAPP_URL.startsWith("https://") ? "__Secure-" : "";
  const state = await createCalCsrfState({ cookie: req.cookies[`${prefix}next-auth.csrf-token`], secret });
  // Legacy SSR reads only the JSON token; the browser /csrf response owns cookie effects.
  return state.token;
}
