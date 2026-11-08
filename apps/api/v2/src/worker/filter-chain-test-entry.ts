import "reflect-metadata";

// biome-ignore lint/style/noRestrictedImports: the fixture throws the canonical calendar error the filter catches
import { CalendarAppError } from "@calcom/lib/CalendarAppError";
import { Prisma } from "@calcom/prisma/client";
import type { ArgumentsHost, ExceptionFilter, Type } from "@nestjs/common";
import {
  Catch,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  UnauthorizedException,
  UseFilters,
} from "@nestjs/common";
import { TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import { createApiWorker } from "./create-api-worker";
import { createGlobalFilterSet } from "./execution/filters";
import type { ApiResponse } from "./execution/shims";
import type { ModuleDefinition, ModuleScope } from "./metadata";
import { defineModule } from "./metadata";
import { OAuth2HttpException } from "@/modules/auth/oauth2/filters/oauth2-http.exception";
import { OAuth2HttpExceptionFilter } from "@/modules/auth/oauth2/filters/oauth2-http-exception.filter";

@Controller({ path: "probe" })
class ProbeController {
  @Get("success")
  success(): { ok: boolean } {
    return { ok: true };
  }

  @Get("http/not-found")
  notFound(): never {
    throw new NotFoundException("missing");
  }

  @Get("http/unauthorized")
  unauthorized(): never {
    throw new UnauthorizedException("no token");
  }

  @Get("http/forbidden")
  forbidden(): never {
    throw new ForbiddenException("denied");
  }

  @Get("zod")
  zod(): never {
    throw new ZodError([{ code: "custom", path: ["name"], message: "Required" }]);
  }

  @Get("prisma")
  prisma(): never {
    throw new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "6.16.3",
    });
  }

  @Get("trpc")
  trpc(): never {
    throw new TRPCError({ code: "NOT_FOUND", message: "gone" });
  }

  @Get("calendar")
  calendar(): never {
    throw new CalendarAppError("calendar broke");
  }

  @Get("unknown")
  unknown(): never {
    throw new Error("boom");
  }

  @Get("filters")
  filters(): { order: string[] } {
    return { order: createGlobalFilterSet().ordered.map((filter) => filter.constructor.name) };
  }
}

@Controller({ path: "probe/oauth2" })
class OAuth2ProbeController {
  @Get()
  @UseFilters(OAuth2HttpExceptionFilter)
  token(): never {
    throw new OAuth2HttpException({ error: "invalid_request", error_description: "bad code" }, 400);
  }
}

class OrderProbeError extends Error {}

@Catch(OrderProbeError)
class ClassOrderFilter implements ExceptionFilter {
  catch(_error: unknown, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<ApiResponse>().status(418).json({ by: "class" });
  }
}

@Catch(OrderProbeError)
class MethodOrderFilter implements ExceptionFilter {
  catch(_error: unknown, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<ApiResponse>().status(409).json({ by: "method" });
  }
}

@Controller({ path: "probe/order" })
@UseFilters(ClassOrderFilter)
class OrderController {
  @Get()
  @UseFilters(MethodOrderFilter)
  get(): never {
    throw new OrderProbeError("order");
  }
}

const probeModule: ModuleDefinition = defineModule({
  key: "probe",
  controllers: [ProbeController, OAuth2ProbeController, OrderController],
  create(): ModuleScope {
    return {
      controllers: new Map<Type<unknown>, object>([
        [ProbeController, new ProbeController()],
        [OAuth2ProbeController, new OAuth2ProbeController()],
        [OrderController, new OrderController()],
      ]),
    };
  },
});

const worker = createApiWorker({ modules: [probeModule] });

export default worker;
