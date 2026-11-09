import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";

type InternalFetch = (request: Request) => Promise<Response>;

const internalFetch = new AsyncLocalStorage<InternalFetch>();

export function withInternalFetch<T>(fetch: InternalFetch, callback: () => T): T {
  return internalFetch.run(fetch, callback);
}

export function fetchInternal(request: Request): Promise<Response> {
  const fetch = internalFetch.getStore();
  if (!fetch) {
    throw new ErrorWithCode(
      ErrorCode.InternalServerError,
      "Internal fetch requires a Worker request context"
    );
  }
  return fetch(request);
}
