import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Subject } from "rxjs";
import type { ModuleScope, RouteRecord } from "../metadata";
import type { GlobalFilterSet } from "./filters";
import { resolveFilters, respondWithFilters } from "./filters";
import type { ApiRequest, ApiResponse, ApiResponseWriter } from "./shims";
import { createRequest, createResponse } from "./shims";
import { BodyModeError, readBody } from "@/lib/body-modes";
import { ResponseInterceptor } from "@/middleware/request-ids/request-id.interceptor";
import { RequestIdMiddleware } from "@/middleware/request-ids/request-id.middleware";

type RequestIdHandler = (
  this: RequestIdMiddleware,
  request: ApiRequest,
  response: ApiResponse,
  next: () => void
) => void;

export function runRequestIdMiddleware(request: ApiRequest, response: ApiResponse): void {
  const use = RequestIdMiddleware.prototype.use as unknown as RequestIdHandler;
  use.call(new RequestIdMiddleware(), request, response, () => undefined);
}

interface RequestLifecycle {
  finish(result: unknown): void;
  fail(error: unknown): void;
}

function startRequestLifecycle({
  request,
  response,
  context,
}: {
  request: ApiRequest;
  response: ApiResponse;
  context: ExecutionContextHost;
}): RequestLifecycle {
  runRequestIdMiddleware(request, response);
  const results = new Subject<unknown>();
  const subscription = new ResponseInterceptor()
    .intercept(context, { handle: () => results })
    .subscribe({ error: () => undefined });

  return {
    finish(result) {
      results.next(result);
      results.complete();
      subscription.unsubscribe();
    },
    fail(error) {
      results.error(error);
      subscription.unsubscribe();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finishRedirect({
  record,
  result,
  response,
}: {
  record: RouteRecord;
  result: unknown;
  response: ApiResponseWriter;
}): boolean {
  if (!record.redirect) return false;
  const redirect = isRecord(result) ? result : undefined;
  const statusCode =
    typeof redirect?.statusCode === "number" ? redirect.statusCode : (record.redirect.statusCode ?? 302);
  const location = typeof redirect?.url === "string" ? redirect.url : record.redirect.url;
  if (location === undefined) return false;
  response.redirect(statusCode, location);
  return true;
}

function finishResult({
  result,
  response,
  responseHandled,
}: {
  result: unknown;
  response: ApiResponseWriter;
  responseHandled: boolean;
}): void {
  if (responseHandled) return;
  if (result === null || result === undefined) {
    response.send();
    return;
  }
  if (typeof result === "object") {
    response.json(result);
    return;
  }
  response.send(String(result));
}

export async function executeRoute({
  record,
  raw,
  params,
  originalUrl,
  controller,
  scope,
  filters,
}: {
  record: RouteRecord;
  raw: Request;
  params: Record<string, string>;
  originalUrl: string;
  controller: object;
  scope: ModuleScope;
  filters: GlobalFilterSet;
}): Promise<Response> {
  const request = createRequest({ raw, params, originalUrl });
  const response = createResponse();
  response.status(record.status);
  for (const header of record.headers) {
    response.setHeader(header.name, typeof header.value === "function" ? header.value() : header.value);
  }

  let body: unknown;
  try {
    body = await readBody({ mode: record.bodyMode, request: raw });
  } catch (error) {
    if (error instanceof BodyModeError) {
      return new Response(error.message, {
        status: error.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
  request.body = body;
  if (body instanceof Uint8Array) request.rawBody = body;

  const next = (): void => undefined;
  const target = Reflect.get(record.controllerClass.prototype, record.methodName);
  const context = new ExecutionContextHost(
    [request, response, next],
    record.controllerClass,
    typeof target === "function" ? target : undefined
  );
  context.setType("http");
  const routeFilters = [
    ...resolveFilters([...record.methodFilters].reverse(), scope),
    ...resolveFilters([...record.classFilters].reverse(), scope),
  ];
  const lifecycle = startRequestLifecycle({ request, response, context });

  try {
    if (record.params.length > 0) {
      throw new Error(
        `Route ${record.method} ${record.path} uses parameters, which arrive with the validation slice`
      );
    }
    const callable = context.getHandler();
    if (typeof callable !== "function") {
      throw new Error(`Controller ${record.controllerClass.name}.${record.methodName} is not callable`);
    }
    const result = await callable.apply(controller, []);
    lifecycle.finish(result);

    const redirected = finishRedirect({ record, result, response });
    if (!redirected) {
      const responseHandled =
        !record.responsePassthrough &&
        record.params.some((param) => param.source === "response" || param.source === "next");
      finishResult({ result, response, responseHandled });
    }
    response.runCloseListeners();
    return response.toResponse();
  } catch (error) {
    lifecycle.fail(error);
    await respondWithFilters({
      error,
      host: context,
      response,
      globals: filters,
      routeFilters,
    });
    response.runCloseListeners();
    return response.toResponse();
  }
}
