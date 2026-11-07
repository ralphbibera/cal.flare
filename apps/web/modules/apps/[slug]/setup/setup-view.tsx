"use client";

import { authClient } from "@calcom/features/auth/client/auth-client";
import { useRouter } from "next/navigation";

import type { getServerSideProps } from "@calcom/app-store/_pages/setup/_getServerSideProps";
import { useCompatSearchParams } from "@calcom/lib/hooks/useCompatSearchParams";
import type { inferSSRProps } from "@calcom/types/inferSSRProps";
import { AppSetupPage } from "@calcom/web/components/apps/AppSetupPage";

export type PageProps = inferSSRProps<typeof getServerSideProps>;

export default function SetupInformation(props: PageProps) {
  const searchParams = useCompatSearchParams();
  const router = useRouter();
  const slug = searchParams?.get("slug") as string;
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <div className="bg-emphasis absolute z-50 flex h-screen w-full items-center" />;
  }

  if (!session) {
    const urlSearchParams = new URLSearchParams({
      callbackUrl: `/apps/${slug}/setup`,
    });
    router.replace(`/auth/login?${urlSearchParams.toString()}`);
  }

  return <AppSetupPage slug={slug} {...props} />;
}
