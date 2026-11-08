import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "./errorCodes";
import { ErrorWithCode } from "./errors";

// Structural because @calcom/lib must stay importable outside Workers without workers-types.
export type RuntimeStateNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(url: string, init: { method: string; body: string; signal?: AbortSignal }): Promise<Response>;
  };
};

export type RuntimeStateEnvironment = { RUNTIME_STATE?: RuntimeStateNamespace };

const storageKey = Symbol.for("calflare.runtime-state.request-storage");
const shared = globalThis as typeof globalThis & {
  [storageKey]?: AsyncLocalStorage<RuntimeStateNamespace | undefined>;
};
// Vinext evaluates server modules separately for RSC and Pages/SSR.
const runtimeState = (shared[storageKey] ??= new AsyncLocalStorage<RuntimeStateNamespace | undefined>());

export function withRuntimeState<T>(env: RuntimeStateEnvironment, callback: () => T): T {
  return runtimeState.run(env.RUNTIME_STATE, callback);
}

export function getRuntimeStateOrNull(): RuntimeStateNamespace | null {
  return runtimeState.getStore() ?? null;
}

export function getRuntimeState(): RuntimeStateNamespace {
  const namespace = getRuntimeStateOrNull();
  if (!namespace) throw new ErrorWithCode(ErrorCode.InternalServerError, "RUNTIME_STATE binding is required");
  return namespace;
}
