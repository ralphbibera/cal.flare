import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { withD1Database } from "@calcom/prisma/d1";
import type { createCalCredentialsAuth } from "./cal-credentials-auth";

export type CredentialPolicy = {
  encryptionKey: string | undefined;
  isDevelopment: boolean;
  isE2E: boolean;
  rateLimit: "disabled" | "enabled";
};
export type AuthRequestConfiguration = Parameters<typeof createCalCredentialsAuth>[0] & {
  credentialPolicy: CredentialPolicy;
};
type AuthRequestEnvironment =
  | (Pick<AuthRequestConfiguration, "NEXTAUTH_SECRET"> & { DB?: never })
  | AuthRequestConfiguration;

const storageKey = Symbol.for("calflare.auth.request-storage");
const shared = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<AuthRequestEnvironment>;
};
// Vinext evaluates RSC and Pages modules separately within the same Worker isolate.
const environment = (shared[storageKey] ??= new AsyncLocalStorage<AuthRequestEnvironment>());

export function withAuthRequestEnvironment<T>(env: AuthRequestEnvironment, callback: () => T): T {
  const run = () => environment.run(env, callback);
  return env.DB !== undefined ? withD1Database(env, run) : run();
}

export function getAuthRequestConfiguration(): AuthRequestConfiguration | undefined {
  const env = environment.getStore();
  return env?.DB !== undefined ? env : undefined;
}

export function getAuthRequestEnvironment(): AuthRequestEnvironment {
  const env = environment.getStore();
  if (!env) throw new ErrorWithCode(ErrorCode.InternalServerError, "Auth request binding is required");
  return env;
}
