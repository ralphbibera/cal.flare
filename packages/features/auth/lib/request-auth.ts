import { createCalCredentialsAuth } from "./cal-credentials-auth";
import type { AuthRequestConfiguration } from "./request-context";
import { withAuthRequestEnvironment } from "./request-context";

// This boundary remains unmounted until every retained provider issues compatible sessions.
export function createCalRequestAuth(config: AuthRequestConfiguration) {
  const auth = createCalCredentialsAuth(config);
  const run = <T>(callback: () => T) => withAuthRequestEnvironment(config, callback);
  return {
    handler: (request: Request) => run(() => auth.handler(request)),
    api: {
      getServerSession: (options: { headers: Headers }) => run(() => auth.api.getServerSession(options)),
      getSessionClaims: (options: { headers: Headers }) => run(() => auth.api.getSessionClaims(options)),
    },
  };
}
