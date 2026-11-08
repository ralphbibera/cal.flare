import {
  API_VERSIONS,
  type API_VERSIONS_ENUM,
  BAD_REQUEST,
  CAL_API_VERSION_HEADER,
  ERROR_STATUS,
  SUCCESS_STATUS,
  VERSION_2024_04_15,
} from "@calcom/platform-constants";
import { userSchemaResponse } from "@calcom/platform-types/me";
import { withD1Database } from "@calcom/prisma/d1";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import {
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { isApiKey, sha256Hash, stripApiKey } from "@/lib/api-key";
import { ApiKeysRepository } from "@/modules/api-keys/api-keys-repository";
import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import { PrismaWriteService } from "@/modules/prisma/prisma-write.service";
import { UsersService } from "@/modules/users/services/users.service";
import { UsersRepository, type UserWithProfile } from "@/modules/users/users.repository";

// Same text as ApiAuthStrategy, which the Worker cannot import because it loads Passport.
const NO_AUTH_PROVIDED_MESSAGE = `No authentication method provided. Either pass an API key as 'Bearer' header or OAuth client credentials as 'x-cal-secret-key' and 'x-cal-client-id' headers`;

// The API-key branch of ApiAuthStrategy. Access tokens, OAuth client credentials, third-party
// tokens and web sessions need their source collaborators and arrive with their endpoint slice.
async function requireApiKeyUser(
  request: Request,
  apiKeyPrefix: string,
  {
    apiKeysRepository: apiKeys,
    usersRepository: users,
  }: Pick<ApiServices, "apiKeysRepository" | "usersRepository">
): Promise<UserWithProfile> {
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "");

  if (!bearerToken) {
    throw new UnauthorizedException(`ApiAuthStrategy - ${NO_AUTH_PROVIDED_MESSAGE}`);
  }
  if (!isApiKey(bearerToken, apiKeyPrefix)) {
    throw new UnauthorizedException("ApiAuthStrategy - Invalid Bearer token");
  }

  const keyData = await apiKeys.getApiKeyFromHash(sha256Hash(stripApiKey(bearerToken, apiKeyPrefix)));
  if (!keyData) {
    throw new UnauthorizedException("ApiAuthStrategy - api key - Your api key is not valid");
  }

  const isKeyExpired =
    keyData.expiresAt && new Date().setHours(0, 0, 0, 0) > keyData.expiresAt.setHours(0, 0, 0, 0);
  if (isKeyExpired) {
    throw new UnauthorizedException("ApiAuthStrategy - api key - Your api key is expired");
  }

  if (!keyData.userId) {
    throw new UnauthorizedException("ApiAuthStrategy - api key - No user tied to this apiKey");
  }

  const user = await users.findByIdWithProfile(keyData.userId);
  if (!user) {
    throw new UnauthorizedException(
      "ApiAuthStrategy - bearer token - No user associated with the provided token"
    );
  }

  return user;
}

type WorkerEnvironment = {
  DB: D1Database;
  API_KEY_PREFIX?: string;
};

type ApiEnvironment = {
  Bindings: WorkerEnvironment;
  Variables: {
    requestId: string;
  };
};

type ApiServices = {
  apiKeysRepository: ApiKeysRepository;
  usersRepository: UsersRepository;
  usersService: UsersService;
};

const servicesByDatabase = new WeakMap<D1Database, ApiServices>();

function servicesFor(database: D1Database): ApiServices {
  const cached = servicesByDatabase.get(database);
  if (cached) return cached;

  const read = new PrismaReadService();
  read.setOptions({ type: "worker", d1: database });
  const write = new PrismaWriteService();
  write.setOptions({ type: "worker", d1: database });

  const usersRepository = new UsersRepository(read, write);
  const services = {
    apiKeysRepository: new ApiKeysRepository(read, write),
    usersRepository,
    usersService: new UsersService(usersRepository),
  };
  servicesByDatabase.set(database, services);
  return services;
}

// Mirrors bootstrap's version extractor: an unsupported header falls back to the default version.
function selectedApiVersion(context: Context<ApiEnvironment>): string {
  const header = context.req.header(CAL_API_VERSION_HEADER);
  return header && API_VERSIONS.includes(header as API_VERSIONS_ENUM) ? header : VERSION_2024_04_15;
}

function versioned(
  supported: readonly string[],
  handler: (context: Context<ApiEnvironment>) => Response | Promise<Response>
) {
  return (context: Context<ApiEnvironment>) => {
    const version = selectedApiVersion(context);
    if (!supported.includes(version)) {
      throw new NotFoundException(`Cannot ${context.req.method} ${context.req.path}`);
    }
    return handler(context);
  };
}

function requestPath(context: Context<ApiEnvironment>): string {
  const url = new URL(context.req.url);
  return `${url.pathname}${url.search}`;
}

function errorResponse(context: Context<ApiEnvironment>, error: unknown): Response {
  if (error instanceof ZodError) {
    const message = error.issues.reduce(
      (acc, issue) => `${issue.path.join(".")} - ${issue.message}, ${acc}`,
      ""
    );
    return context.json(
      {
        status: ERROR_STATUS,
        timestamp: new Date().toISOString(),
        path: requestPath(context),
        error: { code: BAD_REQUEST, message },
      },
      400
    );
  }

  const exception = error instanceof HttpException ? error : new InternalServerErrorException();
  return context.json(
    {
      status: ERROR_STATUS,
      timestamp: new Date().toISOString(),
      path: requestPath(context),
      error: { code: exception.name, message: exception.message, details: exception.getResponse() },
    },
    exception.getStatus() as ContentfulStatusCode
  );
}

function createApiApp(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();

  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set("requestId", requestId);
    await next();
    context.header("X-Request-Id", requestId);
  });
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "PATCH", "DELETE", "HEAD", "POST", "PUT", "OPTIONS"],
      allowHeaders: [
        "x-cal-client-id",
        "x-cal-secret-key",
        "x-cal-platform-embed",
        CAL_API_VERSION_HEADER,
        "Accept",
        "Authorization",
        "Content-Type",
        "Origin",
      ],
      maxAge: 86_400,
    })
  );

  for (const path of ["/v2/health", "/v2/health/", "/api/v2/health", "/api/v2/health/"]) {
    app.get(path, (context) => context.html("OK"));
  }

  const getMe = async (context: Context<ApiEnvironment>) => {
    const services = servicesFor(context.env.DB);
    const user = await requireApiKeyUser(context.req.raw, context.env.API_KEY_PREFIX ?? "cal_", services);
    const organization = services.usersService.getUserMainProfile(user)?.organization;
    const me = userSchemaResponse.parse(
      organization
        ? {
            ...user,
            organizationId: organization.id,
            organization: { id: organization.id, isPlatform: organization.isPlatform },
          }
        : user
    );
    return context.json({ status: SUCCESS_STATUS, data: me });
  };
  for (const path of ["/v2/me", "/v2/me/", "/api/v2/me", "/api/v2/me/"]) {
    app.get(path, versioned(API_VERSIONS, getMe));
  }

  app.notFound((context) =>
    errorResponse(context, new NotFoundException(`Cannot ${context.req.method} ${context.req.path}`))
  );
  app.onError((error, context) => errorResponse(context, error));

  return app;
}

const app = createApiApp();

export default {
  fetch(request: Request, env: WorkerEnvironment, ctx: ExecutionContext): Response | Promise<Response> {
    if (!env?.DB) throw new Error("Worker bindings are required");
    return withD1Database(env, () => app.fetch(request, env, ctx));
  },
};

// biome-ignore lint/style/noRestrictedImports: the web Worker binds this Durable Object class to calflare-api-v2
export { RuntimeState } from "@calcom/lib/RuntimeState";
