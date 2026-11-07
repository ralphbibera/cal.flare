import { prisma } from "@calcom/prisma";
import { IdentityProvider } from "@calcom/prisma/enums";
import type { GetServerSidePropsContext, NextApiResponse } from "next";

type UpdateProfileOptions = {
  ctx: {
    user: {
      id: number;
      identityProvider: IdentityProvider;
      identityProviderId: string | null;
    };
    res?: NextApiResponse | GetServerSidePropsContext["res"];
  };
};

const unlinkConnectedAccount = async ({ ctx }: UpdateProfileOptions) => {
  const { user } = ctx;
  const provider = user.identityProvider.toLocaleLowerCase();
  // If it fails to delete, don't stop because the users login data might not be present
  try {
    await prisma.account.delete({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: user.identityProviderId || "",
        },
      },
    });
  } catch {
    // Fail silently if we don't have a record in the account table
  }
  // Fall back to the default identity provider
  const _user = await prisma.user.update({
    where: {
      id: user.id,
      identityProvider: IdentityProvider.GOOGLE,
      identityProviderId: { not: null },
    },
    data: {
      identityProvider: IdentityProvider.CAL,
      identityProviderId: null,
    },
    select: {
      id: true,
    },
  });
  if (!_user) return { message: "account_unlinked_error" };
  return { message: "account_unlinked_success" };
};

export default unlinkConnectedAccount;
