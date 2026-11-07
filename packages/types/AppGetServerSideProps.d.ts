import type { GetServerSidePropsContext, GetServerSidePropsResult } from "next";

import type { CalServerSession } from "@calcom/features/auth/lib/cal-server-session";
import type prisma from "@calcom/prisma";

export type AppUser = CalServerSession["user"] | undefined;
export type AppPrisma = typeof prisma;
export type AppGetServerSidePropsContext = GetServerSidePropsContext<{
  pages: string[];
}>;

export type AppGetServerSideProps = (
  context: AppGetServerSidePropsContext,
  prisma: AppPrisma,
  user: AppUser
) => GetServerSidePropsResult;
