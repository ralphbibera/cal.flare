import { IS_OUTLOOK_LOGIN_ENABLED } from "@calcom/features/auth/lib/outlook";
import { IS_GOOGLE_LOGIN_ENABLED } from "@server/lib/constants";

export async function getServerSideProps() {
  const providers = [
    ...(IS_GOOGLE_LOGIN_ENABLED ? [{ id: "google" as const, name: "Google" }] : []),
    // Better Auth registers Azure AD under the social id "microsoft".
    ...(IS_OUTLOOK_LOGIN_ENABLED ? [{ id: "microsoft" as const, name: "Azure AD" }] : []),
  ];
  return { props: { providers } };
}
