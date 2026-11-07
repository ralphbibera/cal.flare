import type { BetterAuthClientPlugin } from "better-auth/client";
import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { CalCredentialsServerPlugin } from "../lib/cal-credentials-auth";
import type { browserSession } from "../lib/cal-session";

const calCredentialsClient = {
  id: "cal-credentials",
  $InferServerPlugin: {} as CalCredentialsServerPlugin,
  // Profile switches and session updates change the projection, so they invalidate the session atom.
  atomListeners: [
    {
      matcher: (path: string) => path === "/cal/update-session",
      signal: "$sessionSignal",
    },
  ],
} satisfies BetterAuthClientPlugin;

const client = createAuthClient({
  basePath: "/api/auth",
  plugins: [calCredentialsClient, magicLinkClient()],
});

export type CalSession = ReturnType<typeof browserSession>;
export type CalSessionUser = CalSession["user"];

type CalSessionState = Omit<ReturnType<typeof client.useSession>, "data"> & {
  data: CalSession | null;
};

// Better Auth infers the core `{ user, session }` shape for `useSession`; the Cal plugin replaces
// `/get-session` with the Cal projection, which the inference does not follow.
export const authClient = client as Omit<typeof client, "useSession"> & {
  useSession: () => CalSessionState;
};
