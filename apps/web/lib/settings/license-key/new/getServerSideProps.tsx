import { getServerSession } from "@calcom/feature-auth/lib/getServerSession";
import type { GetServerSidePropsContext } from "next";

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const session = await getServerSession({
    req: context.req,
  });
  // Disable this check if we ever make this self serve.
  if (session?.user.role !== "ADMIN") {
    return {
      notFound: true,
    } as const;
  }

  return {
    props: {},
  };
};
