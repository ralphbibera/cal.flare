import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";

type AuthRequestEnvironment = { NEXTAUTH_SECRET: string };

const storageKey = Symbol.for("calflare.auth.request-storage");
const shared = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<AuthRequestEnvironment>;
};
// Vinext evaluates RSC and Pages modules separately within the same Worker isolate.
const environment = (shared[storageKey] ??= new AsyncLocalStorage<AuthRequestEnvironment>());

export function withAuthRequestEnvironment<T>(env: AuthRequestEnvironment, callback: () => T): T {
  return environment.run(env, callback);
}

export function getAuthRequestEnvironment(): AuthRequestEnvironment {
  const env = environment.getStore();
  if (!env) throw new ErrorWithCode(ErrorCode.InternalServerError, "Auth request binding is required");
  return env;
}
