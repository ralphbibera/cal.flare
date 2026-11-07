"use client";

import { authClient } from "@calcom/features/auth/client/auth-client";

import type { inferSSRProps } from "@calcom/types/inferSSRProps";
import { Button } from "@calcom/ui/components/button";

import type { getServerSideProps } from "@server/lib/auth/signin/getServerSideProps";

export type PageProps = inferSSRProps<typeof getServerSideProps>;
function Signin({ providers }: PageProps) {
  return (
    <div className="center mt-10 justify-between stack-y-5 text-center align-baseline">
      {providers.map((provider) => {
        return (
          <div key={provider.id}>
            <Button onClick={() => authClient.signIn.social({ provider: provider.id, callbackURL: "/" })}>Sign in with {provider.name}</Button>
          </div>
        );
      })}
    </div>
  );
}

export default Signin;
