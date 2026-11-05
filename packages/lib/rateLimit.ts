import process from "node:process";
import type { Duration, Limit, LimitOptions, RatelimitResponse } from "@unkey/ratelimit";
import { isIpInBanListString } from "./getIP";
import logger from "./logger";
import type { RateLimitRequest } from "./RuntimeState";
import { getRuntimeState } from "./runtimeStateContext";

const log = logger.getSubLogger({ prefix: ["RateLimit"] });

export type { RatelimitResponse };

export type RateLimitHelper = {
  rateLimitingType?:
    | "core"
    | "forcedSlowMode"
    | "common"
    | "api"
    | "ai"
    | "sms"
    | "smsMonth"
    | "instantMeeting";
  identifier: string;
  opts?: LimitOptions;
  /**
   * Using a callback instead of a regular return to provide headers even
   * when the rate limit is reached and an error is thrown.
   **/
  onRateLimiterResponse?: (response: RatelimitResponse) => void;
};

export const API_KEY_RATE_LIMIT = 30;

const LIMITS: Record<NonNullable<RateLimitHelper["rateLimitingType"]>, Limit> = {
  core: { limit: 10, duration: "60s" },
  instantMeeting: { limit: 1, duration: "10m" },
  common: { limit: 200, duration: "60s" },
  forcedSlowMode: { limit: 1, duration: "30s" },
  api: { limit: API_KEY_RATE_LIMIT, duration: "60s" },
  ai: { limit: 20, duration: "1d" },
  sms: { limit: 50, duration: "5m" },
  smsMonth: { limit: 250, duration: "30d" },
};

const TIMEOUT_MS = 5000;
const FAIL_OPEN_RESPONSE: RatelimitResponse = { success: true, limit: 10, remaining: 999, reset: 0 };
const UNIT_MILLISECONDS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function toMilliseconds(duration: Duration | number): number {
  if (typeof duration === "number") return duration;
  const match = duration.match(/^(\d+)\s?(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Unable to parse window size: ${duration}`);
  return Number(match[1]) * UNIT_MILLISECONDS[match[2] as keyof typeof UNIT_MILLISECONDS];
}

let warned = false;

export function rateLimiter() {
  const { UNKEY_ROOT_KEY } = process.env;

  if (!UNKEY_ROOT_KEY) {
    if (!warned) {
      log.warn("Disabled because the UNKEY_ROOT_KEY environment variable was not found.");
      warned = true;
    }
    return () => ({ success: true, limit: 10, remaining: 999, reset: 0 }) as RatelimitResponse;
  }

  async function limit(namespace: keyof typeof LIMITS, identifier: string, opts?: LimitOptions) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { limit, duration } = opts?.limit ?? LIMITS[namespace];
      const state = getRuntimeState();
      const body: RateLimitRequest = {
        identifier,
        limit,
        duration: toMilliseconds(duration),
        cost: opts?.cost ?? 1,
      };
      const consumed = state
        .get(state.idFromName(`rate-limit:${namespace}`))
        .fetch("https://runtime-state/rate-limit", { method: "POST", body: JSON.stringify(body) })
        .then((response) => {
          if (!response.ok) throw new Error(`RUNTIME_STATE responded with status ${response.status}`);
          return response.json() as Promise<RatelimitResponse>;
        });
      return await Promise.race([
        consumed,
        new Promise<RatelimitResponse>((resolve) => {
          timer = setTimeout(() => resolve(FAIL_OPEN_RESPONSE), TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log.error("Unkey rate limiter encountered unknown error", {
        error: err.message,
        stack: err.stack,
        identifier,
        timestamp: new Date().toISOString(),
      });
      return FAIL_OPEN_RESPONSE;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rateLimit({ rateLimitingType = "core", identifier, opts }: RateLimitHelper) {
    if (isIpInBanListString(identifier)) {
      return await limit("forcedSlowMode", identifier, opts);
    }

    return await limit(rateLimitingType, identifier, opts);
  }

  return rateLimit;
}
