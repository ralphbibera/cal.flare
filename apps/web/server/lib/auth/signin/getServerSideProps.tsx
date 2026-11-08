import { enabledOAuthProviders, readOAuthProvidersConfig } from "@calcom/features/auth/lib/cal-oauth";

type SignInProvider = { id: "google" | "microsoft"; name: string };

// The page signs in through Better Auth, whose social id for Azure differs from the stored provider id.
const SIGNIN_PROVIDERS = new Map<string, SignInProvider>([
  ["google", { id: "google", name: "Google" }],
  ["azure-ad", { id: "microsoft", name: "Azure AD" }],
]);

export async function getServerSideProps() {
  // Read the same request-bound config the auth server uses so the page cannot advertise a provider sign-in rejects.
  const providers: SignInProvider[] = [];
  for (const provider of enabledOAuthProviders(readOAuthProvidersConfig())) {
    const signInProvider = SIGNIN_PROVIDERS.get(provider);
    if (signInProvider) providers.push(signInProvider);
  }
  return { props: { providers } };
}
