import parser from "accept-language-parser";
import type { GetServerSidePropsContext, NextApiRequest } from "next";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import i18nConfig from "@calcom/i18n/next-i18next.config";

const { i18n } = i18nConfig;

type Maybe<T> = T | null | undefined;

export async function getLocaleFromRequest(
  req: NextApiRequest | GetServerSidePropsContext["req"]
): Promise<string> {
  const session = await getServerSession({ req });
  if (session?.user?.locale) return session.user.locale;
  let preferredLocale: string | null | undefined;
  if (req.headers["accept-language"]) {
    preferredLocale = parser.pick(i18n.locales, req.headers["accept-language"], {
      loose: true,
    }) as Maybe<string>;
  }
  return preferredLocale ?? i18n.defaultLocale;
}
