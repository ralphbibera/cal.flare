import { createModule } from "@calcom/features/di/di";
import { DI_TOKENS } from "@calcom/features/di/tokens";
import { getRuntimeStateOrNull } from "@calcom/lib/runtimeStateContext";
import { NoopRedisService } from "../NoopRedisService";
import { RedisService } from "../RedisService";

const redisModule = createModule();

// RUNTIME_STATE is request-scoped, so resolve the binding on every lookup instead of
// caching the first request's choice for the isolate lifetime.
redisModule.bind(DI_TOKENS.REDIS_CLIENT).toFactory(() => {
  if (!getRuntimeStateOrNull()) {
    return new NoopRedisService();
  }
  return new RedisService();
}, "transient");

export { redisModule };
