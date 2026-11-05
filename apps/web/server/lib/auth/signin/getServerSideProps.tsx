import { getServerCsrfToken } from "@calcom/features/auth/lib/getServerCsrfToken";
import type { GetServerSidePropsContext } from "next";
import { getProviders } from "next-auth/react";

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const csrfToken = await getServerCsrfToken(context.req);
  const providers = await getProviders();
  return {
    props: {
      csrfToken,
      providers,
    },
  };
}
