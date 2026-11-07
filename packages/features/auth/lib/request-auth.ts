import { createCalCredentialsAuth } from "./cal-credentials-auth";
import type { AuthRequestConfiguration } from "./request-context";
import { withAuthRequestEnvironment } from "./request-context";

// Binds the Better Auth handler and Cal server reads to one request configuration.
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
