import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitHelper } from "./rateLimit";
import { API_KEY_RATE_LIMIT, rateLimiter } from "./rateLimit";
import type { RuntimeStateNamespace } from "./runtimeStateContext";
import { withRuntimeState } from "./runtimeStateContext";

const logged = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("./logger", () => ({ default: { ...logged, getSubLogger: () => logged } }));

const FAIL_OPEN = { success: true, limit: 10, remaining: 999, reset: 0 };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HARNESS = `
  import { RuntimeState as Base } from "./RuntimeState";
  export class RuntimeState extends Base {
    constructor(ctx) { super(ctx); this.sql = ctx.storage.sql; }
    async fetch(request) {
      if (new URL(request.url).pathname !== "/rows") return super.fetch(request);
      const rows = "SELECT COUNT(*) AS n FROM rate_limit_window WHERE identifier = ?";
      return Response.json(this.sql.exec(rows, await request.text()).one().n);
    }
  }
  export class Broken { fetch() { throw new Error("runtime state unavailable"); } }
  export class Hanging { async fetch() { await new Promise((done) => setTimeout(done, 8000)); } }
  export default { fetch() { return new Response(); } };`;

describe("rateLimiter on the RUNTIME_STATE Durable Object", () => {
  let mf: Miniflare;
  const namespaces: Record<string, RuntimeStateNamespace> = {};
  const limit = (args: RateLimitHelper, namespace = namespaces.RUNTIME_STATE) =>
    withRuntimeState({ RUNTIME_STATE: namespace }, () => rateLimiter()(args));

  beforeAll(async () => {
    const { worker } = (await import("../../apps/web/cloudflare.config")).default;
    const stdin = { contents: HARNESS, resolveDir: __dirname, loader: "js" as const };
    const { outputFiles } = await build({ stdin, bundle: true, format: "esm", write: false });
    const durableObject = { type: "durable-object", storage: "sqlite" } as const;
    const owner = { type: "durable-object", worker: worker.name } as const;
    const env = {
      RUNTIME_STATE: worker.env.RUNTIME_STATE,
      BROKEN: { ...owner, exportName: "Broken" },
      HANGING: { ...owner, exportName: "Hanging" },
    };
    const exports = { RuntimeState: durableObject, Broken: durableObject, Hanging: durableObject };
    mf = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: worker.name,
            compatibilityDate: worker.compatibilityDate,
            compatibilityFlags: worker.compatibilityFlags,
            env,
            exports,
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm" as const, contents: outputFiles[0].text } },
            },
          },
        },
      ],
    });
    for (const binding of Object.keys(env)) {
      const namespace = await mf.getDurableObjectNamespace(binding, worker.name);
      namespaces[binding] = namespace as unknown as RuntimeStateNamespace;
    }
  }, 60_000);

  afterAll(() => mf?.dispose());

  beforeEach(() => {
    vi.stubEnv("UNKEY_ROOT_KEY", "configured");
    vi.stubEnv("IP_BANLIST", "[]");
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["core", 10, 60_000],
    ["instantMeeting", 1, 600_000],
    ["common", 200, 60_000],
    ["forcedSlowMode", 1, 30_000],
    ["api", API_KEY_RATE_LIMIT, 60_000],
    ["ai", 20, 86_400_000],
    ["sms", 50, 300_000],
    ["smsMonth", 250, 2_592_000_000],
  ] as const)("applies %s as %i per %i ms", async (rateLimitingType, expected, window) => {
    const before = Date.now();
    const response = await limit({ rateLimitingType, identifier: randomUUID() });
    expect(response).toEqual({
      success: true,
      limit: expected,
      remaining: expected - 1,
      reset: expect.any(Number),
    });
    expect(response.reset % window).toBe(0);
    expect(response.reset).toBeGreaterThan(before);
    expect(response.reset).toBeLessThanOrEqual(Date.now() + window);
  });

  it("defaults to core and denies without consuming once the limit is spent", async () => {
    const identifier = randomUUID();
    const responses = [];
    for (let attempt = 0; attempt < 12; attempt++) responses.push(await limit({ identifier }));
    expect(responses.map(({ success }) => success)).toEqual([...Array(10).fill(true), false, false]);
    expect(responses.map(({ remaining }) => remaining)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0]);
  });

  it("honours cost and limit overrides", async () => {
    const identifier = randomUUID();
    const opts = { cost: 4, limit: { limit: 6, duration: "1h" as const } };
    expect(await limit({ identifier, opts })).toMatchObject({ success: true, limit: 6, remaining: 2 });
    expect(await limit({ identifier, opts })).toMatchObject({ success: false, remaining: 0 });
  });

  it("admits again as the previous window slides out", async () => {
    const identifier = randomUUID();
    const duration = 2000;
    const opts = { limit: { limit: 2, duration } };
    await delay(duration - (Date.now() % duration));
    const { reset } = await limit({ identifier, opts });
    await limit({ identifier, opts });
    expect(await limit({ identifier, opts })).toEqual({ success: false, limit: 2, remaining: 0, reset });
    await delay(reset - Date.now() + 100);
    expect(await limit({ identifier, opts })).toMatchObject({ success: false, reset: reset + duration });
    await delay(reset + duration * 0.75 - Date.now());
    expect(await limit({ identifier, opts })).toMatchObject({ success: true, reset: reset + duration });
  }, 15_000);

  it("does not over-admit concurrent requests", async () => {
    const identifier = randomUUID();
    const responses = await Promise.all(Array.from({ length: 40 }, () => limit({ identifier })));
    expect(responses.filter(({ success }) => success)).toHaveLength(10);
  });

  it("isolates identifiers and namespaces", async () => {
    const identifier = randomUUID();
    const rateLimitingType = "instantMeeting";
    await limit({ rateLimitingType, identifier });
    expect(await limit({ rateLimitingType, identifier })).toMatchObject({ success: false });
    expect(await limit({ rateLimitingType, identifier: randomUUID() })).toMatchObject({ success: true });
    expect(await limit({ rateLimitingType: "forcedSlowMode", identifier })).toMatchObject({ success: true });
  });

  it("routes ban-listed identifiers to forcedSlowMode", async () => {
    const identifier = randomUUID();
    vi.stubEnv("IP_BANLIST", JSON.stringify([identifier]));
    expect(await limit({ rateLimitingType: "common", identifier })).toMatchObject({
      success: true,
      limit: 1,
    });
    expect(await limit({ rateLimitingType: "common", identifier })).toMatchObject({
      success: false,
      limit: 1,
    });
  });

  it("removes expired windows", async () => {
    const identifier = randomUUID();
    const stub = namespaces.RUNTIME_STATE.get(namespaces.RUNTIME_STATE.idFromName("rate-limit:ai"));
    const stored = async () => {
      return (await stub.fetch("https://runtime-state/rows", { method: "POST", body: identifier })).json();
    };
    await limit({ rateLimitingType: "ai", identifier, opts: { limit: { limit: 1, duration: 400 } } });
    expect(await stored()).toBe(1);
    await vi.waitFor(async () => expect(await stored()).toBe(0), { timeout: 5000, interval: 100 });
  });

  it("stays disabled without UNKEY_ROOT_KEY and never touches the Durable Object", async () => {
    vi.stubEnv("UNKEY_ROOT_KEY", "");
    const untouched = { idFromName: vi.fn(), get: vi.fn() };
    expect(await limit({ identifier: randomUUID() }, untouched)).toEqual(FAIL_OPEN);
    expect(await limit({ identifier: randomUUID() }, untouched)).toEqual(FAIL_OPEN);
    expect(untouched.idFromName).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledTimes(1);
  });

  it("fails open and logs when the Durable Object errors or the binding is missing", async () => {
    const identifier = randomUUID();
    expect(await limit({ identifier }, namespaces.BROKEN)).toEqual(FAIL_OPEN);
    expect(logged.error).toHaveBeenCalledWith(
      "Unkey rate limiter encountered unknown error",
      expect.objectContaining({ error: expect.stringContaining("runtime state unavailable"), identifier })
    );
    expect(await rateLimiter()({ identifier })).toEqual(FAIL_OPEN);
    expect(logged.error).toHaveBeenCalledTimes(2);
  });

  it("fails open silently after five seconds when the Durable Object hangs", async () => {
    const started = Date.now();
    expect(await limit({ identifier: randomUUID() }, namespaces.HANGING)).toEqual(FAIL_OPEN);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    expect(Date.now() - started).toBeLessThan(7000);
    expect(logged.error).not.toHaveBeenCalled();
  }, 15_000);
});
