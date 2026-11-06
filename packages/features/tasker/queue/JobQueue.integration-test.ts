import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { calendarsTaskConfig } from "@calcom/features/calendars/lib/tasker/trigger/config";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { build } from "esbuild";
import { Miniflare, MiniflareWorkerConfigSchema } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextRetryDelayMs } from "./JobQueue";

const CALENDAR_JOB_ID = "calendars.ensure-default-calendars";

const fixtureWorker = `
import { getCalendarsTasker } from "@calcom/features/calendars/di/tasker/CalendarsTasker.container";
import { ensureDefaultCalendarsJob } from "@calcom/features/calendars/lib/tasker/trigger/ensure-default-calendars";
import { calendarsTaskConfig } from "@calcom/features/calendars/lib/tasker/trigger/config";
import { calendarsTaskSchema } from "@calcom/features/calendars/lib/tasker/trigger/schema";
import { consumeJobBatch, defineQueueJob, enqueueJob, withJobQueue } from "@calcom/features/tasker/queue/JobQueue";
import { TaskProcessor } from "@calcom/features/tasker/task-processor";
import { withD1Database } from "@calcom/prisma/d1";

const failingRun = async () => {
  await fetch("https://provider.invalid/always-fails");
  throw new Error("provider effect failed");
};
const failingJob = defineQueueJob({
  id: "test.fails-quickly",
  schema: calendarsTaskSchema,
  retry: { ...calendarsTaskConfig.retry, minTimeoutInMs: 1000, randomize: false },
  run: failingRun,
});
const failingJobWithCalendarTiming = defineQueueJob({
  id: "test.fails-with-calendar-timing",
  schema: calendarsTaskSchema,
  retry: calendarsTaskConfig.retry,
  run: failingRun,
});
const jobs = [ensureDefaultCalendarsJob, failingJob, failingJobWithCalendarTiming];

const deliveries = [];
let loseNextAck = false;

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const body = request.method === "POST" ? await request.json() : undefined;
  if (pathname === "/dispatch") return getCalendarsTasker().ensureDefaultCalendars({ payload: body });
  if (pathname === "/dispatch-broken-queue") {
    const JOBS = { send: () => Promise.reject(new Error("queue unavailable")) };
    return withJobQueue({ JOBS }, () => getCalendarsTasker().ensureDefaultCalendars({ payload: body }));
  }
  if (pathname === "/enqueue-failing") return enqueueJob(failingJob, body);
  if (pathname === "/enqueue-failing-calendar-timing") return enqueueJob(failingJobWithCalendarTiming, body);
  if (pathname === "/send") return env.JOBS.send(body);
  if (pathname === "/lose-next-ack") return void (loseNextAck = true);
  if (pathname === "/sweep") return new TaskProcessor().processQueue();
  if (pathname === "/deliveries") return deliveries;
  return null;
}

export default {
  async fetch(request, env) {
    const result = await withD1Database(env, () => withJobQueue(env, () => route(request, env)));
    return Response.json(result ?? null);
  },
  queue(batch, env) {
    const messages = batch.messages.map((message) => {
      deliveries.push({ runId: message.body.runId, attempts: message.attempts });
      if (!loseNextAck) return message;
      loseNextAck = false;
      return { body: message.body, ack: () => message.retry(), retry: (options) => message.retry(options) };
    });
    return withD1Database(env, () => withJobQueue(env, () => consumeJobBatch({ ...batch, messages }, jobs)));
  },
};
`;

type Delivery = { runId: string; attempts: number };
type TaskRow = {
  id: string;
  type: string;
  attempts: number;
  maxAttempts: number;
  succeededAt: string | null;
  scheduledAt: string;
  lastFailedAttemptAt: string | null;
  lastError: string | null;
};

describe("JOBS queue job path in workerd", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const providerCalls: string[] = [];
  const failingProviderTokens = new Set<string>();

  async function provider(request: { url: string; headers: { get(name: string): string | null } }) {
    const { hostname, pathname } = new URL(request.url);
    const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    providerCalls.push(`${token} ${hostname}${pathname}`);
    const { Response } = await import("miniflare");
    if (failingProviderTokens.has(token) || pathname === "/always-fails") {
      return new Response("provider down", { status: 500 });
    }
    if (pathname.endsWith("/calendars")) {
      return Response.json({
        value: [{ id: `calendar-${token}`, name: "Primary", isDefaultCalendar: true, canEdit: true }],
      });
    }
    return Response.json({ mail: `${token}@example.invalid`, userPrincipalName: `${token}@example.invalid` });
  }

  const call = async <T>(path: string, body?: unknown, worker?: string): Promise<T> => {
    const init = body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) };
    const url = `https://jobs.test${path}`;
    const response = worker
      ? await (await mf.getWorker(worker)).fetch(url, init)
      : await mf.dispatchFetch(url, init);
    return (await response.json()) as T;
  };

  const readTask = (id: string) =>
    db.prepare('SELECT * FROM "Task" WHERE "id" = ?').bind(id).first<TaskRow>();
  const deliveriesOf = async (runId: string) =>
    (await call<Delivery[]>("/deliveries")).filter((delivery) => delivery.runId === runId);
  const providerCallsOf = (token: string) => providerCalls.filter((entry) => entry.startsWith(`${token} `));
  const destinationCalendars = async (userId: number) =>
    (
      await db
        .prepare('SELECT "externalId" FROM "DestinationCalendar" WHERE "userId" = ?')
        .bind(userId)
        .all<{ externalId: string }>()
    ).results.map(({ externalId }) => externalId);

  async function seedUser(userId: number) {
    const key = JSON.stringify({
      access_token: `user-${userId}`,
      refresh_token: "refresh",
      expires_in: 4102444800,
      expiry_date: 4102444800000,
    });
    await db.batch([
      db
        .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
        .bind(userId, `job-user-${userId}`, `user-${userId}@example.invalid`),
      db
        .prepare('INSERT INTO "Credential" ("type", "key", "appId", "userId") VALUES (?, ?, ?, ?)')
        .bind("office365_calendar", key, "office365-calendar", userId),
    ]);
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-jobs-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });

    const outdir = join(directory, "bundle");
    const bundled = await build({
      stdin: { contents: fixtureWorker, resolveDir: __dirname, loader: "js" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      splitting: true,
      outdir,
      entryNames: "worker",
      chunkNames: "chunk-[hash]",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "import"],
      external: ["node:*", "cloudflare:*", ...builtinModules, "*.wasm?module"],
      loader: {
        ".node": "empty",
        ".wasm": "file",
        ".css": "empty",
        ".svg": "text",
        ".md": "text",
        ".html": "text",
      },
      jsx: "automatic",
      logLevel: "silent",
    });
    const compiler = await readFile(
      join(__dirname, "../../../prisma/generated/prisma/internal/query_compiler_bg.wasm")
    );
    const modules = {
      "query_compiler_bg.wasm?module": { type: "wasm" as const, contents: new Uint8Array(compiler) },
      ...Object.fromEntries(
        bundled.outputFiles
          .filter((file) => file.path.endsWith(".js"))
          .map((file) => [relative(outdir, file.path), { type: "esm" as const, contents: file.text }])
      ),
    };

    const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
    const base = {
      compatibilityDate: worker.compatibilityDate,
      compatibilityFlags: worker.compatibilityFlags,
      manifest: { mainModule: "worker.js", modules },
    };
    // The local D1 identity derives from the worker name; every fixture worker must share the web one.
    const DB = MiniflareWorkerConfigSchema.parse({ ...base, name: worker.name, env: { DB: worker.env.DB } })
      .env?.DB;
    const dev = { outboundService: { type: "fetcher" as const, handler: provider } };
    mf = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(persistTo, "v3"),
      workers: [
        {
          config: {
            ...base,
            name: worker.name,
            env: {
              DB,
              JOBS: worker.env.JOBS,
              ENABLE_ASYNC_TASKER: { type: "text", value: "true" },
            },
            triggers: worker.triggers?.map((trigger) =>
              // Real batching waits seconds to fill a batch, which only slows this test down.
              trigger.type === "queue" ? { ...trigger, maxBatchTimeout: 0 } : trigger
            ),
          },
          dev,
        },
        {
          config: {
            ...base,
            name: "without-queue-binding",
            env: { DB, ENABLE_ASYNC_TASKER: { type: "text", value: "true" } },
          },
          dev,
        },
        {
          config: {
            ...base,
            name: "without-async-opt-in",
            env: { DB, JOBS: worker.env.JOBS },
          },
          dev,
        },
      ],
    });
    db = await mf.getD1Database("DB");
    await db
      .prepare(
        'INSERT INTO "App" ("slug", "dirName", "categories", "enabled", "updatedAt") VALUES (?, ?, ?, 1, ?)'
      )
      .bind("office365-calendar", "office365calendar", '["calendar"]', "2026-11-05T00:00:00.000+00:00")
      .run();
  }, 180_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("enqueues, consumes and completes the calendar job against D1", async () => {
    await seedUser(1);

    const { runId } = await call<{ runId: string }>("/dispatch", { userId: 1 });

    await expect.poll(async () => (await readTask(runId))?.succeededAt, { timeout: 20_000 }).toBeTruthy();
    const task = await readTask(runId);
    expect(task).toMatchObject({ type: CALENDAR_JOB_ID, attempts: 1, maxAttempts: 3, lastError: null });
    expect(await destinationCalendars(1)).toEqual(["calendar-user-1"]);
    expect(providerCallsOf("user-1").length).toBeGreaterThan(0);
  });

  it("does not repeat a completed run when the queue redelivers it", async () => {
    await seedUser(2);
    await call("/lose-next-ack", {});

    const { runId } = await call<{ runId: string }>("/dispatch", { userId: 2 });

    await expect.poll(() => deliveriesOf(runId), { timeout: 30_000 }).toHaveLength(2);
    const [first, redelivered] = await deliveriesOf(runId);
    expect(first.attempts).toBe(1);
    expect(redelivered.attempts).toBe(2);
    await expect.poll(async () => (await readTask(runId))?.succeededAt).toBeTruthy();
    expect((await readTask(runId))?.attempts).toBe(1);
    const callsAfterRun = providerCallsOf("user-2").length;
    await call("/send", { runId });
    await expect.poll(() => deliveriesOf(runId), { timeout: 20_000 }).toHaveLength(3);
    expect((await readTask(runId))?.attempts).toBe(1);
    expect(providerCallsOf("user-2")).toHaveLength(callsAfterRun);
    expect(await destinationCalendars(2)).toHaveLength(1);
  });

  it("retries a throwing run with Task attempts until the budget is spent", async () => {
    const before = providerCallsOf(" ").length;
    const { runId } = await call<{ runId: string }>("/enqueue-failing", { userId: 3 });

    await expect.poll(async () => (await readTask(runId))?.attempts, { timeout: 30_000 }).toBe(3);

    const task = await readTask(runId);
    expect(task).toMatchObject({ maxAttempts: 3, succeededAt: null, lastError: "provider effect failed" });
    const deliveries = await deliveriesOf(runId);
    expect(deliveries).toHaveLength(3);
    // Each Task retry is a new message, so none of them spends the transport's redelivery budget.
    expect(deliveries.map(({ attempts }) => attempts)).toEqual([1, 1, 1]);
    await call("/send", { runId });
    await expect.poll(() => deliveriesOf(runId), { timeout: 20_000 }).toHaveLength(4);
    expect((await readTask(runId))?.attempts).toBe(3);
    expect(providerCallsOf("").filter((entry) => entry.includes("/always-fails")).length - before).toBe(3);
  });

  it("schedules the next attempt with the calendar job's retry timing", async () => {
    const { runId } = await call<{ runId: string }>("/enqueue-failing-calendar-timing", { userId: 4 });

    await expect.poll(async () => (await readTask(runId))?.attempts, { timeout: 20_000 }).toBe(1);

    const task = await readTask(runId);
    const delayMs = Date.parse(task?.scheduledAt ?? "") - Date.parse(task?.lastFailedAttemptAt ?? "");
    expect(delayMs).toBeGreaterThanOrEqual(60_000);
    expect(delayMs).toBeLessThanOrEqual(120_000);
  });

  it("keeps a swallowed provider failure terminal instead of retrying it", async () => {
    await seedUser(5);
    failingProviderTokens.add("user-5");

    const { runId } = await call<{ runId: string }>("/dispatch", { userId: 5 });

    await expect.poll(async () => (await readTask(runId))?.succeededAt, { timeout: 20_000 }).toBeTruthy();
    expect(await readTask(runId)).toMatchObject({ attempts: 1, lastError: null, lastFailedAttemptAt: null });
    expect(providerCallsOf("user-5").length).toBeGreaterThan(0);
    expect(await deliveriesOf(runId)).toHaveLength(1);
  });

  it("does not run a delivery that arrives before the run is due", async () => {
    await seedUser(6);
    const runId = "not-yet-due";
    await db
      .prepare(
        'INSERT INTO "Task" ("id", "type", "payload", "scheduledAt", "updatedAt") VALUES (?, ?, ?, ?, ?)'
      )
      .bind(
        runId,
        CALENDAR_JOB_ID,
        '{"userId":6}',
        "2100-01-01T00:00:00.000+00:00",
        "2026-11-05T00:00:00.000+00:00"
      )
      .run();

    await call("/send", { runId });

    await expect.poll(() => deliveriesOf(runId), { timeout: 20_000 }).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await readTask(runId)).toMatchObject({ attempts: 0, succeededAt: null });
    expect(providerCallsOf("user-6")).toEqual([]);
  });

  it("fails an invalid stored payload without retrying, as Trigger does", async () => {
    const runId = "invalid-payload";
    await db
      .prepare('INSERT INTO "Task" ("id", "type", "payload", "updatedAt") VALUES (?, ?, ?, ?)')
      .bind(runId, CALENDAR_JOB_ID, '{"userId":"seven"}', "2026-11-05T00:00:00.000+00:00")
      .run();

    await call("/send", { runId });

    await expect.poll(async () => (await readTask(runId))?.attempts, { timeout: 20_000 }).toBe(3);
    expect((await readTask(runId))?.lastError).toBeTruthy();
    expect(await deliveriesOf(runId)).toHaveLength(1);
  });

  it("leaves queue-backed rows to JOBS when the internal task sweep runs", async () => {
    const runId = "not-for-the-sweep";
    await db
      .prepare(
        'INSERT INTO "Task" ("id", "type", "payload", "scheduledAt", "updatedAt") VALUES (?, ?, ?, ?, ?)'
      )
      .bind(
        runId,
        CALENDAR_JOB_ID,
        '{"userId":8}',
        "2026-11-05T00:00:00.000+00:00",
        "2026-11-05T00:00:00.000+00:00"
      )
      .run();

    await call("/sweep", {});

    expect(await readTask(runId)).toMatchObject({ attempts: 0, succeededAt: null, lastError: null });
  });

  it.each(["without-queue-binding", "without-async-opt-in"])("stays synchronous %s", async (worker) => {
    const userId = worker === "without-queue-binding" ? 9 : 10;
    await seedUser(userId);

    const { runId } = await call<{ runId: string }>("/dispatch", { userId }, worker);

    expect(runId).toMatch(/^sync_/);
    expect(await destinationCalendars(userId)).toEqual([`calendar-user-${userId}`]);
    const pending = await db
      .prepare('SELECT COUNT(*) AS "count" FROM "Task" WHERE "payload" = ?')
      .bind(JSON.stringify({ userId }))
      .first<{ count: number }>();
    expect(pending?.count).toBe(0);
  });

  it("removes the run and falls back to synchronous when the send fails", async () => {
    await seedUser(11);

    const { runId } = await call<{ runId: string }>("/dispatch-broken-queue", { userId: 11 });

    expect(runId).toMatch(/^sync_/);
    expect(await destinationCalendars(11)).toEqual(["calendar-user-11"]);
    const pending = await db
      .prepare('SELECT COUNT(*) AS "count" FROM "Task" WHERE "payload" = ?')
      .bind(JSON.stringify({ userId: 11 }))
      .first<{ count: number }>();
    expect(pending?.count).toBe(0);
  });

  it("computes the same delays as Trigger's retry formula", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.37);
    // min(maxTimeout, (random + 1) * minTimeout * factor ** (attempt - 1)), none once attempts are spent.
    expect([1, 2, 3].map((attempt) => nextRetryDelayMs(calendarsTaskConfig.retry, attempt))).toEqual([
      82_200,
      164_400,
      undefined,
    ]);
    expect(nextRetryDelayMs({ maxAttempts: 10, randomize: false }, 8)).toBe(60_000);
    expect(nextRetryDelayMs(undefined, 2)).toBe(2_740);
    random.mockRestore();
  });
});
