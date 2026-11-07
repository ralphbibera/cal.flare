import type { NextApiHandler } from "next";
import type { CalServerSession } from "@calcom/features/auth/lib/cal-server-session";
import type { Credential } from "@calcom/prisma/client";

export type AppDeclarativeHandler = {
  appType: string;
  slug: string;
  variant: string;
  supportsMultipleInstalls: false;
  handlerType: "add";
  createCredential: (arg: {
    user: CalServerSession["user"];
    appType: string;
    slug: string;
    teamId?: number;
  }) => Promise<Credential>;
  supportsMultipleInstalls: boolean;
  redirect?: {
    newTab?: boolean;
    url: string;
  };
};
export type AppHandler = AppDeclarativeHandler | NextApiHandler;
