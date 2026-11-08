import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import { FILTER_CATCH_EXCEPTIONS } from "@nestjs/common/constants";
import type { FilterRef, ModuleScope } from "../metadata";
import type { ApiResponseWriter } from "./shims";
import { CalendarServiceExceptionFilter } from "@/filters/calendar-service-exception.filter";
import { HttpExceptionFilter } from "@/filters/http-exception.filter";
import { PrismaExceptionFilter } from "@/filters/prisma-exception.filter";
import { TRPCExceptionFilter } from "@/filters/trpc-exception.filter";
import { ZodExceptionFilter } from "@/filters/zod-exception.filter";

const UNKNOWN_EXCEPTION_MESSAGE = "Internal server error";

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isHttpError(error: unknown): error is { statusCode: number; message: string } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { statusCode?: unknown; message?: unknown };
  return Boolean(candidate.statusCode) && Boolean(candidate.message);
}

function reply(response: ApiResponseWriter, body: unknown, status: number): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.status(status).json(body);
}

/** Reproduces @nestjs/core BaseExceptionFilter for the two shapes the source host relies on. */
export class WorkerExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionsHandler");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ApiResponseWriter>();

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      const body = isObject(exceptionResponse)
        ? exceptionResponse
        : { statusCode: exception.getStatus(), message: exceptionResponse };
      reply(response, body, exception.getStatus());
      return;
    }

    const body = isHttpError(exception)
      ? { statusCode: exception.statusCode, message: exception.message }
      : { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: UNKNOWN_EXCEPTION_MESSAGE };
    reply(response, body, body.statusCode);

    if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      return;
    }
    this.logger.error(exception);
  }
}

export interface GlobalFilterSet {
  /** Effective order: Calendar, TRPC, Http, Zod, Prisma, fallback. */
  readonly ordered: readonly ExceptionFilter[];
  select(error: unknown, routeFilters: readonly ExceptionFilter[]): ExceptionFilter;
}

function catches(filter: ExceptionFilter, error: unknown): boolean {
  const types: unknown = Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, filter.constructor);
  if (!Array.isArray(types) || types.length === 0) return true;
  return types.some((type) => typeof type === "function" && error instanceof type);
}

/** Nest reverses [global, class, method] before selection, so the last registered global runs first. */
export function createGlobalFilterSet(): GlobalFilterSet {
  const ordered: readonly ExceptionFilter[] = [
    new CalendarServiceExceptionFilter(),
    new TRPCExceptionFilter(),
    new HttpExceptionFilter(),
    new ZodExceptionFilter(),
    new PrismaExceptionFilter(),
    new WorkerExceptionFilter(),
  ];
  return {
    ordered,
    select(error, routeFilters) {
      const selected = [...routeFilters, ...ordered].find((filter) => catches(filter, error));
      if (!selected) throw new Error("unreachable: the fallback filter catches every error");
      return selected;
    },
  };
}

export function resolveFilters(refs: readonly FilterRef[], scope: ModuleScope): readonly ExceptionFilter[] {
  return refs.map((ref) => {
    if (typeof ref !== "function") return ref;
    const provided = scope.filters?.find((filter) => filter.constructor === ref);
    return provided ?? new ref();
  });
}

/** Selects the first matching route or global filter and writes its response. */
export async function respondWithFilters({
  error,
  host,
  response,
  globals,
  routeFilters,
}: {
  error: unknown;
  host: ArgumentsHost;
  response: ApiResponseWriter;
  globals: GlobalFilterSet;
  routeFilters: readonly ExceptionFilter[];
}): Promise<void> {
  const filter = globals.select(error, routeFilters);
  try {
    await filter.catch(error, host);
  } catch {
    if (response.headersSent) return;
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: UNKNOWN_EXCEPTION_MESSAGE,
    });
  }
}
