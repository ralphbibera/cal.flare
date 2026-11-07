import { IS_GOOGLE_LOGIN_ENABLED } from "@server/lib/constants";

export async function getServerSideProps() {
  const providers = IS_GOOGLE_LOGIN_ENABLED ? [{ id: "google" as const, name: "Google" }] : [];
  return { props: { providers } };
}
