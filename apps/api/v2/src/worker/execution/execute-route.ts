import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import type { RouteRecord } from "../metadata";
import type { ApiResponseWriter } from "./shims";
import { createRequest, createResponse } from "./shims";
import { BodyModeError, readBody } from "@/lib/body-modes";

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
}: {
  record: RouteRecord;
  raw: Request;
  params: Record<string, string>;
  originalUrl: string;
  controller: object;
}): Promise<Response> {
  if (record.params.length > 0) {
    throw new Error(
      `Route ${record.method} ${record.path} uses parameters, which arrive with the validation slice`
    );
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

  const request = createRequest({ raw, params, originalUrl });
  request.body = body;
  if (body instanceof Uint8Array) request.rawBody = body;

  const response = createResponse();
  response.status(record.status);
  for (const header of record.headers) {
    response.setHeader(header.name, typeof header.value === "function" ? header.value() : header.value);
  }

  const next = (): void => undefined;
  const prototype = record.controllerClass.prototype;
  const target = Reflect.get(prototype, record.methodName);
  if (typeof target !== "function") {
    throw new Error(`Controller ${record.controllerClass.name}.${record.methodName} is not callable`);
  }
  const context = new ExecutionContextHost([request, response, next], record.controllerClass, target);
  context.setType("http");

  const callable = context.getHandler();
  if (typeof callable !== "function") {
    throw new Error(`Controller ${record.controllerClass.name}.${record.methodName} is not callable`);
  }
  const result = await callable.apply(controller, []);

  const redirected = finishRedirect({ record, result, response });
  if (!redirected) {
    const responseHandled =
      !record.responsePassthrough &&
      record.params.some((param) => param.source === "response" || param.source === "next");
    finishResult({ result, response, responseHandled });
  }
  response.runCloseListeners();
  return response.toResponse();
}
