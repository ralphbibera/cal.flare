import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { RedisRequest } from "@calcom/lib/RuntimeState";
import { getRuntimeState } from "@calcom/lib/runtimeStateContext";
import type { IRedisService } from "./IRedisService";

const REDIS_STATE_OBJECT = "redis";
const TIMEOUT_MS = 2000;

function serialize(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new ErrorWithCode(ErrorCode.InternalServerError, "Unable to serialize value for RUNTIME_STATE");
  }
  return json;
}

export class RedisService implements IRedisService {
  async get<TData>(key: string): Promise<TData | null> {
    const { result } = await this.send<{ result: string | null }>({ op: "get", key });
    return result === null ? null : (JSON.parse(result) as TData);
  }

  async del(key: string): Promise<number> {
    const { result } = await this.send<{ result: number }>({ op: "del", key });
    return result;
  }

  async set<TData>(key: string, value: TData, opts?: { ttl?: number }): Promise<"OK" | TData | null> {
    await this.send({ op: "set", key, value: serialize(value), ...(opts?.ttl ? { ttl: opts.ttl } : {}) });
    return "OK";
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    const { result } = await this.send<{ result: 0 | 1 }>({ op: "expire", key, seconds });
    return result;
  }

  async lrange<TResult = string>(key: string, start: number, end: number): Promise<TResult[]> {
    const { result } = await this.send<{ result: string[] }>({ op: "lrange", key, start, end });
    return result.map((value) => JSON.parse(value) as TResult);
  }

  async lpush<TData>(key: string, ...elements: TData[]): Promise<number> {
    const { result } = await this.send<{ result: number }>({
      op: "lpush",
      key,
      values: elements.map(serialize),
    });
    return result;
  }

  private async send<TResult>(command: RedisRequest): Promise<TResult> {
    const state = getRuntimeState();
    const response = await state
      .get(state.idFromName(REDIS_STATE_OBJECT))
      .fetch("https://runtime-state/redis", {
        method: "POST",
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      let message = `RUNTIME_STATE redis command failed with status ${response.status}`;
      if (typeof body?.error === "string") message = body.error;
      throw new ErrorWithCode(ErrorCode.InternalServerError, message);
    }

    return (await response.json()) as TResult;
  }
}

export { REDIS_STATE_OBJECT };
