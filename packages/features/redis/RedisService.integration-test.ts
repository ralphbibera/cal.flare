import { randomUUID } from "node:crypto";
import path from "node:path";
import { getRedisService } from "@calcom/features/di/containers/Redis";
import { rateLimiter } from "@calcom/lib/rateLimit";
import type { RuntimeStateNamespace } from "@calcom/lib/runtimeStateContext";
import { withRuntimeState } from "@calcom/lib/runtimeStateContext";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NoopRedisService } from "./NoopRedisService";
import { REDIS_STATE_OBJECT, RedisService } from "./RedisService";

const HARNESS = `
  import { RuntimeState as Base } from "./RuntimeState";
  export class RuntimeState extends Base {
    constructor(ctx) { super(ctx); this.sql = ctx.storage.sql; }
    async fetch(request) {
      if (new URL(request.url).pathname !== "/rows") return super.fetch(request);
      const key = await request.text();
      return Response.json(this.sql.exec("SELECT COUNT(*) AS n FROM cache_entry WHERE key = ?", key).one().n);
    }
  }
  export default { fetch() { return new Response(); } };`;

describe("RedisService on the RUNTIME_STATE Durable Object", () => {
  let mf: Miniflare;
  let namespace: RuntimeStateNamespace;
  const redis = new RedisService();
  const run = <T>(callback: () => Promise<T>) => withRuntimeState({ RUNTIME_STATE: namespace }, callback);

  beforeAll(async () => {
    const { worker } = (await import("../../../apps/web/cloudflare.config")).default;
    const stdin = {
      contents: HARNESS,
      resolveDir: path.join(__dirname, "../../lib"),
      loader: "js" as const,
    };
    const { outputFiles } = await build({ stdin, bundle: true, format: "esm", write: false });
    const durableObject = { type: "durable-object", storage: "sqlite" } as const;
    const owner = { type: "durable-object", worker: "calflare-api-v2" } as const;
    const config = (name: string, contents: string) => ({
      name,
      compatibilityDate: worker.compatibilityDate,
      compatibilityFlags: worker.compatibilityFlags,
      manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm" as const, contents } } },
    });
    mf = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            ...config(worker.name, "export default {fetch(){return new Response()}}"),
            env: { RUNTIME_STATE: worker.env.RUNTIME_STATE },
          },
        },
        {
          config: { ...config(owner.worker, outputFiles[0].text), exports: { RuntimeState: durableObject } },
        },
      ],
    });
    namespace = (await mf.getDurableObjectNamespace(
      "RUNTIME_STATE",
      worker.name
    )) as unknown as RuntimeStateNamespace;
  }, 60_000);

  afterAll(() => mf?.dispose());

  it("selects the Durable Object adapter while the binding is available", () => {
    expect(getRedisService()).toBeInstanceOf(NoopRedisService);
    withRuntimeState({ RUNTIME_STATE: namespace }, () => {
      expect(getRedisService()).toBeInstanceOf(RedisService);
    });
  });

  it("round-trips JSON values, lists and misses", async () => {
    const key = `cache:${randomUUID()}`;
    await run(() => redis.set(key, { id: 1, name: "cached" }, { ttl: 60_000 }));
    expect(await run(() => redis.get(key))).toEqual({ id: 1, name: "cached" });
    expect(await run(() => redis.get(`missing:${randomUUID()}`))).toBeNull();
    expect(await run(() => redis.lpush(`${key}:list`, "a", "b"))).toBe(2);
    expect(await run(() => redis.lrange(`${key}:list`, 0, -1))).toEqual(["b", "a"]);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => run(() => redis.lpush(`${key}:many`, String(index))))
    );
    expect(await run(() => redis.lrange(`${key}:many`, 0, -1))).toHaveLength(20);
  });

  it("expires values after the millisecond TTL and removes the rows", async () => {
    const key = `ttl:${randomUUID()}`;
    await run(() => redis.set(key, "short lived", { ttl: 1000 }));
    expect(await run(() => redis.get(key))).toBe("short lived");
    const stub = namespace.get(namespace.idFromName(REDIS_STATE_OBJECT));
    const rows = async () =>
      (await stub.fetch("https://runtime-state/rows", { method: "POST", body: key })).json();
    await vi.waitFor(async () => expect(await rows()).toBe(0), {
      timeout: 5000,
      interval: 100,
    });
    expect(await run(() => redis.get(key))).toBeNull();
  });

  it("sets and clears expiry in seconds", async () => {
    const key = `expire:${randomUUID()}`;
    await run(() => redis.set(key, "value"));
    expect(await run(() => redis.expire(key, 1))).toBe(1);
    await vi.waitFor(async () => expect(await run(() => redis.get(key))).toBeNull(), {
      timeout: 5000,
      interval: 100,
    });
  });

  it("keeps the auto-lock get, set, expire and delete sequence", async () => {
    const key = `autolock:${randomUUID()}`;
    expect(await run(() => redis.get(key))).toBeNull();
    await run(() => redis.set(key, "1"));
    await run(() => redis.expire(key, 1800));
    expect(await run(() => redis.get(key))).toBe("1");
    expect(await run(() => redis.del(key))).toBe(1);
  });

  it("keeps rate-limit counters independent of cached keys", async () => {
    vi.stubEnv("UNKEY_ROOT_KEY", "configured");
    vi.stubEnv("IP_BANLIST", "[]");
    try {
      const identifier = `rate-limit:${randomUUID()}`;
      const limit = rateLimiter();
      await run(() => redis.set(identifier, "cached"));
      expect(await run(() => limit({ identifier }))).toMatchObject({ success: true, remaining: 9 });
      expect(await run(() => limit({ identifier }))).toMatchObject({ success: true, remaining: 8 });
      expect(await run(() => redis.get(identifier))).toBe("cached");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
