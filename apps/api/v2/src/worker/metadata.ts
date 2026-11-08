import { API_VERSIONS, VERSION_2024_04_15 } from "@calcom/platform-constants";
import type { ExceptionFilter, Type } from "@nestjs/common";
import {
  EXCEPTION_FILTERS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  REDIRECT_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
  VERSION_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common/enums/request-method.enum";
import { VERSION_NEUTRAL } from "@nestjs/common/interfaces/version-options.interface";
import type { BodyMode } from "@/lib/body-modes";

type RouteHandler = (...args: unknown[]) => unknown;

const API_VERSION_VALUES: readonly string[] = API_VERSIONS;

const REQUEST_METHODS: Readonly<Record<number, RouteMethod>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.ALL]: "ALL",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
  [RequestMethod.SEARCH]: "SEARCH",
};

const PARAM_SOURCES: Readonly<Record<number, ParamSourceKind>> = {
  0: "request",
  1: "response",
  2: "next",
  3: "body",
  4: "query",
  5: "param",
  6: "headers",
  7: "session",
  10: "host",
  11: "ip",
  12: "rawBody",
};

const RAW_BODY_PATHS: Set<string> = new Set([
  "/v2/webhooks/vercel/deployment-promoted",
  "/v2/billing/webhook",
]);
const URLENCODED_PATHS: Set<string> = new Set(["/v2/auth/oauth2/token"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function addLeadingSlash(path: string): string {
  return path !== "" && !path.startsWith("/") ? `/${path}` : path;
}

function stripEndSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function normalizePath(path: string): string {
  const stripped = stripEndSlash(addLeadingSlash(path));
  return stripped === "" ? "/" : stripped;
}

function joinRoutePath(controllerPath: string, methodPath: string): string {
  const joined = `${stripEndSlash(addLeadingSlash(controllerPath))}${addLeadingSlash(methodPath)}`;
  const path = normalizePath(joined);
  if (/[()?#]/.test(path)) {
    throw new Error(`Route path ${path} uses syntax outside the Worker host's Hono route table`);
  }
  return path;
}

function readControllerPaths(controller: Type<unknown>): readonly string[] {
  const path: unknown = Reflect.getMetadata(PATH_METADATA, controller);
  if (path === undefined) return ["/"];
  if (typeof path === "string") return [path];
  if (isStringArray(path)) return path;
  throw new Error(`Controller ${controller.name} has a non-string path metadata value`);
}

function readControllerVersion(controller: Type<unknown>): unknown {
  return Reflect.getMetadata(VERSION_METADATA, controller);
}

function toRouteVersion(methodVersion: unknown, controllerVersion: unknown): RouteVersion {
  const value = methodVersion !== undefined ? methodVersion : controllerVersion;
  if (value === undefined || value === VERSION_NEUTRAL) return { kind: "neutral" };
  if (typeof value === "string") return { kind: "versions", values: [value] };
  if (Array.isArray(value)) {
    if (value.includes(VERSION_NEUTRAL)) return { kind: "neutral" };
    if (isStringArray(value)) return { kind: "versions", values: value };
  }
  throw new Error("Route version metadata must be a string, VERSION_NEUTRAL or an array of versions");
}

function readMethodPaths(path: unknown): readonly string[] {
  if (typeof path === "string") return [path];
  if (isStringArray(path)) return path;
  throw new Error("Route path metadata must be a string or an array of strings");
}

function isFilterInstance(value: unknown): value is ExceptionFilter {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { catch?: unknown }).catch === "function";
}

function readFilterRefs(metadata: unknown, source: string): readonly FilterRef[] {
  if (metadata === undefined) return [];
  if (!Array.isArray(metadata)) throw new Error(`Filters for ${source} are not an array`);
  return metadata.map((ref) => {
    if (typeof ref === "function") return ref as Type<ExceptionFilter>;
    if (isFilterInstance(ref)) return ref;
    throw new Error(`Filter for ${source} is neither a class nor an instance`);
  });
}

function readClassFilters(controller: Type<unknown>): readonly FilterRef[] {
  return readFilterRefs(
    Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, controller),
    `${controller.name} class`
  );
}

function readMethodFilters(
  controller: Type<unknown>,
  methodName: string,
  handler: RouteHandler
): readonly FilterRef[] {
  return readFilterRefs(
    Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, handler),
    `${controller.name}.${methodName}`
  );
}

function readRouteParams(controller: Type<unknown>, methodName: string): readonly RouteParam[] {
  const metadata: unknown = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName);
  if (metadata === undefined) return [];
  if (!isRecord(metadata)) throw new Error(`Route arguments for ${methodName} are not an object`);

  return Object.entries(metadata).map(([key, value]) => {
    if (!isRecord(value)) throw new Error(`Route argument ${key} on ${methodName} is not an object`);
    const index = value.index;
    const pipes = value.pipes;
    if (typeof index !== "number" || !Array.isArray(pipes)) {
      throw new Error(`Route argument ${key} on ${methodName} is missing its index or pipes`);
    }
    if (pipes.length > 0) {
      throw new Error(
        `Route argument ${key} on ${methodName} uses pipes, which arrive with the validation slice`
      );
    }
    if (key.startsWith("__customRouteArgs__")) {
      throw new Error(
        `Route argument ${key} on ${methodName} uses a custom decorator, which is not implemented yet`
      );
    }
    const [rawType] = key.split(":");
    const source = PARAM_SOURCES[Number(rawType)];
    if (!source) {
      throw new Error(`Route argument ${key} on ${methodName} uses unsupported parameter type ${rawType}`);
    }
    return { index, source, data: value.data, pipes };
  });
}

function readResponseHeaders(handler: RouteHandler): readonly ResponseHeader[] {
  const metadata: unknown = Reflect.getMetadata(HEADERS_METADATA, handler);
  if (metadata === undefined) return [];
  if (!Array.isArray(metadata)) throw new Error("Response headers metadata is not an array");
  return metadata.map((header) => {
    if (!isRecord(header) || typeof header.name !== "string") {
      throw new Error("Response header metadata is missing its name");
    }
    if (typeof header.value !== "string" && typeof header.value !== "function") {
      throw new Error(`Response header ${header.name} has an unsupported value`);
    }
    const value = header.value;
    return {
      name: header.name,
      value: typeof value === "string" ? value : () => String(value()),
    };
  });
}

function readRedirect(handler: RouteHandler): RedirectMetadata | undefined {
  const metadata: unknown = Reflect.getMetadata(REDIRECT_METADATA, handler);
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) throw new Error("Redirect metadata is not an object");
  const { statusCode, url } = metadata;
  if (statusCode !== undefined && typeof statusCode !== "number") {
    throw new Error("Redirect status code must be a number");
  }
  if (url !== undefined && typeof url !== "string") throw new Error("Redirect url must be a string");
  return { statusCode, url };
}

function bodyModeFor(method: RouteMethod, path: string): BodyMode {
  if (RAW_BODY_PATHS.has(path)) return "raw";
  if (URLENCODED_PATHS.has(path)) return "urlencoded";
  return method === "ALL" ? "none" : "json";
}

function versionsOverlap(left: RouteVersion, right: RouteVersion): boolean {
  if (left.kind === "neutral" || right.kind === "neutral") return true;
  return left.values.some((value) => right.values.includes(value));
}

function assertNoVersionOverlap(records: readonly RouteRecord[]): void {
  for (let left = 0; left < records.length; left++) {
    for (let right = left + 1; right < records.length; right++) {
      const a = records[left];
      const b = records[right];
      if (a.method === b.method && a.path === b.path && versionsOverlap(a.version, b.version)) {
        throw new Error(
          `Routes ${a.controllerClass.name}.${a.methodName} and ${b.controllerClass.name}.${b.methodName} overlap on ${a.method} ${a.path}`
        );
      }
    }
  }
}

export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD" | "ALL" | "SEARCH";

export type RouteVersion =
  | { readonly kind: "neutral" }
  | { readonly kind: "versions"; readonly values: readonly string[] };

export type ParamSourceKind =
  | "request"
  | "response"
  | "next"
  | "body"
  | "rawBody"
  | "query"
  | "param"
  | "headers"
  | "ip"
  | "session"
  | "host";

export interface RouteParam {
  readonly index: number;
  readonly source: ParamSourceKind;
  readonly data: unknown;
  readonly pipes: readonly unknown[];
}

export type FilterRef = Type<ExceptionFilter> | ExceptionFilter;

export interface ResponseHeader {
  readonly name: string;
  readonly value: string | (() => string);
}

export interface RedirectMetadata {
  readonly statusCode?: number;
  readonly url?: string;
}

export interface RouteRecord {
  readonly moduleKey: string;
  readonly controllerClass: Type<unknown>;
  readonly methodName: string;
  readonly method: RouteMethod;
  readonly path: string;
  readonly version: RouteVersion;
  readonly status: number;
  readonly headers: readonly ResponseHeader[];
  readonly redirect?: RedirectMetadata;
  readonly params: readonly RouteParam[];
  readonly bodyMode: BodyMode;
  readonly responsePassthrough: boolean;
  readonly classFilters: readonly FilterRef[];
  readonly methodFilters: readonly FilterRef[];
}

export interface ModuleScope {
  readonly controllers: ReadonlyMap<Type<unknown>, object>;
  readonly filters?: readonly ExceptionFilter[];
}

export interface ModuleDefinition {
  readonly key: string;
  readonly controllers: readonly Type<unknown>[];
  create(): ModuleScope;
}

export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return definition;
}

/** Expands the controller decorators exactly like Nest's PathsExplorer and RoutePathFactory. */
export function buildRouteTable(modules: readonly ModuleDefinition[]): readonly RouteRecord[] {
  const records: RouteRecord[] = [];

  for (const module of modules) {
    for (const controller of module.controllers) {
      const controllerPaths = readControllerPaths(controller);
      const controllerVersion = readControllerVersion(controller);

      for (const methodName of Object.getOwnPropertyNames(controller.prototype)) {
        if (methodName === "constructor") continue;
        const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, methodName);
        const handler = descriptor?.value;
        if (typeof handler !== "function") continue;

        const pathMetadata: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        if (pathMetadata === undefined) continue;

        const requestMethod: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof requestMethod !== "number" || !(requestMethod in REQUEST_METHODS)) {
          throw new Error(`Route ${controller.name}.${methodName} has unsupported method metadata`);
        }
        const method = REQUEST_METHODS[requestMethod];
        const methodVersion: unknown = Reflect.getMetadata(VERSION_METADATA, handler);
        const version = toRouteVersion(methodVersion, controllerVersion);
        const httpCode: unknown = Reflect.getMetadata(HTTP_CODE_METADATA, handler);
        if (httpCode !== undefined && typeof httpCode !== "number") {
          throw new Error(`Route ${controller.name}.${methodName} has a non-numeric @HttpCode`);
        }
        const status = httpCode ?? (method === "POST" ? 201 : 200);
        const responsePassthrough = Boolean(
          Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, controller, methodName)
        );
        const classFilters = readClassFilters(controller);
        const methodFilters = readMethodFilters(controller, methodName, handler);

        for (const controllerPath of controllerPaths) {
          for (const methodPath of readMethodPaths(pathMetadata)) {
            const path = joinRoutePath(controllerPath, methodPath);
            records.push({
              moduleKey: module.key,
              controllerClass: controller,
              methodName,
              method,
              path,
              version,
              status,
              headers: readResponseHeaders(handler),
              redirect: readRedirect(handler),
              params: readRouteParams(controller, methodName),
              bodyMode: bodyModeFor(method, path),
              responsePassthrough,
              classFilters,
              methodFilters,
            });
          }
        }
      }
    }
  }

  assertNoVersionOverlap(records);
  return records;
}

export function versionMatches(route: RouteVersion, selected: string): boolean {
  if (route.kind === "neutral") return true;
  return route.values.includes(selected);
}

export function extractApiVersion(header: string | undefined): string {
  if (header && API_VERSION_VALUES.includes(header)) return header;
  return VERSION_2024_04_15;
}
