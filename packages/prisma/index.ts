import process from "node:process";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { PrismaD1 } from "@prisma/adapter-d1";
import { type D1RequestScope, getD1Database, getD1RequestScope } from "./d1";
import { bookingIdempotencyKeyExtension } from "./extensions/booking-idempotency-key";
import { disallowUndefinedDeleteUpdateManyExtension } from "./extensions/disallow-undefined-delete-update-many";
import { excludeLockedUsersExtension } from "./extensions/exclude-locked-users";
import { excludePendingPaymentsExtension } from "./extensions/exclude-pending-payment-teams";
import { type Prisma, PrismaClient } from "./generated/prisma/client";

const prismaOptions: Prisma.PrismaClientOptions = {};
const loggerLevel = parseInt(process.env.NEXT_PUBLIC_LOGGER_LEVEL ?? "", 10);

if (!isNaN(loggerLevel)) {
  switch (loggerLevel) {
    case 5:
    case 6:
      prismaOptions.log = ["error"];
      break;
    case 4:
      prismaOptions.log = ["warn", "error"];
      break;
    case 3:
      prismaOptions.log = ["info", "error", "warn"];
      break;
    default:
      // For values 0, 1, 2 (or anything else below 3)
      prismaOptions.log = ["query", "info", "error", "warn"];
      break;
  }
}
export const customPrisma = (options?: Prisma.PrismaClientOptions) => {
  if (options?.adapter || options?.datasourceUrl || options?.datasources) {
    throw new ErrorWithCode(ErrorCode.BadRequest, "Custom Prisma clients must use the request D1 binding");
  }

  // Prisma's client binds its D1 adapter connection to the I/O context of the request
  // that first uses it. A client kept beyond that request leaves later queries waiting
  // on I/O that has already finished, so it is cached per request, not per binding.
  const clients = new WeakMap<D1RequestScope, PrismaClient>();
  const finalOptions = { ...prismaOptions, ...options };
  // The public instance must be import-safe before a request supplies DB.
  const target = new PrismaClient({
    ...finalOptions,
    adapter: {
      provider: "sqlite",
      adapterName: "@prisma/adapter-d1",
      connect: () => new PrismaD1(getD1Database()).connect(),
    },
  });
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") return undefined;
      const request = getD1RequestScope();
      let client = clients.get(request);
      if (!client) {
        client = new PrismaClient({ ...finalOptions, adapter: new PrismaD1(request.database) })
          .$extends(excludeLockedUsersExtension())
          .$extends(excludePendingPaymentsExtension())
          .$extends(bookingIdempotencyKeyExtension())
          .$extends(disallowUndefinedDeleteUpdateManyExtension()) as unknown as PrismaClient;
        clients.set(request, client);
      }
      const value = Reflect.get(client, property, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
};

export const prisma = customPrisma();
export const readonlyPrisma = prisma;

type OmitPrismaClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// we cant pass tx to functions as types miss match since we have a custom prisma client https://github.com/prisma/prisma/discussions/20924#discussioncomment-10077649
export type {
  OmitPrismaClient as PrismaTransaction,
  // we re-export the native PrismaClient type for backwards-compatibility.
  PrismaClient,
};

/**
 * @deprecated Use named export `prisma` instead
 */
export default prisma;
export * from "./selects";
