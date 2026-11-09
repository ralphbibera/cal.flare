import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REQUEST_BOOKING_NOTIFICATIONS_JOB_ID } from "@calcom/features/bookings/lib/tasker/trigger/notifications/request";
import { calendarsTaskConfig } from "@calcom/features/calendars/lib/tasker/trigger/config";
import { webhookDeliveryTaskConfig } from "@calcom/features/webhooks/lib/tasker/trigger/config";
import { WEBHOOK_DELIVERY_JOB_ID } from "@calcom/features/webhooks/lib/tasker/trigger/deliver-webhook";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { build } from "esbuild";
import { Miniflare, MiniflareWorkerConfigSchema } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextRetryDelayMs } from "./JobQueue";

const CALENDAR_JOB_ID = "calendars.ensure-default-calendars";

const fixtureWorker = `
import { requestBookingNotificationsJob } from "@calcom/features/bookings/lib/tasker/trigger/notifications/request";
import { getCalendarsTasker } from "@calcom/features/calendars/di/tasker/CalendarsTasker.container";
import { ensureDefaultCalendarsJob } from "@calcom/features/calendars/lib/tasker/trigger/ensure-default-calendars";
import { calendarsTaskConfig } from "@calcom/features/calendars/lib/tasker/trigger/config";
import { calendarsTaskSchema } from "@calcom/features/calendars/lib/tasker/trigger/schema";
import { webhookContainer } from "@calcom/features/di/webhooks/containers/webhook";
import { WEBHOOK_TOKENS } from "@calcom/features/di/webhooks/Webhooks.tokens";
import { defineQueueJob, runJobs } from "@calcom/features/tasker/queue/JobQueue";
import { withJobQueue } from "@calcom/features/tasker/queue/context";
import { dispatchJobBatch, isInternalJobDispatch } from "@calcom/features/tasker/queue/internal-dispatch";
import { queueFromName } from "@calcom/features/tasker/queue/queues";
import { deliverWebhookJob } from "@calcom/features/webhooks/lib/tasker/trigger/deliver-webhook";
import { withD1Database } from "@calcom/prisma/d1";

const failingRun = async () => {
  await fetch("https://provider.invalid/always-fails");
  throw new Error("provider effect failed");
};
const failingJob = defineQueueJob({
  id: "test.fails-quickly",
  queue: "calendars",
  schema: calendarsTaskSchema,
  retry: {
    ...calendarsTaskConfig.retry,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 2000,
    randomize: false,
  },
  run: failingRun,
});
const jobs = [ensureDefaultCalendarsJob, requestBookingNotificationsJob, deliverWebhookJob, failingJob];
const jobsForQueue = (queue) => jobs.filter((job) => job.queue === queue);

const deliveries = [];

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const body = request.method === "POST" ? await request.json() : undefined;
  if (pathname === "/dispatch") return getCalendarsTasker().ensureDefaultCalendars({ payload: body });
  if (pathname === "/dispatch-broken-queue") {
    const JOBS_CALENDARS = { send: () => Promise.reject(new Error("queue unavailable")) };
    return withJobQueue({ JOBS_CALENDARS }, () => getCalendarsTasker().ensureDefaultCalendars({ payload: body }));
  }
  if (pathname === "/dispatch-webhook") {
    return webhookContainer.get(WEBHOOK_TOKENS.WEBHOOK_TASKER).deliverWebhook(body);
  }
  if (pathname === "/enqueue-webhook") return deliverWebhookJob.enqueue(body);
  if (pathname === "/enqueue-booking") return requestBookingNotificationsJob.enqueue(body);
  if (pathname === "/enqueue-failing") return failingJob.enqueue(body);
  if (pathname === "/send-raw") return env.JOBS_WEBHOOKS.send(body);
  if (pathname === "/deliveries") return deliveries;
  return null;
}

export default {
  async fetch(request, env) {
    const result = await withD1Database(env, () => withJobQueue(env, () => route(request, env)));
    return Response.json(result ?? null);
  },
  queue(batch, env) {
    const queue = queueFromName(batch.queue);
    if (!queue) throw new Error("Unknown queue " + batch.queue);
    const messages = batch.messages.map((message) => {
      deliveries.push({ jobId: message.body.jobId, runId: message.body.runId, attempts: message.attempts });
      return message;
    });
    return withD1Database(env, () =>
      withJobQueue(env, () =>
        dispatchJobBatch({ queue, messages }, async (request) => {
          if (!isInternalJobDispatch()) return new Response("Unauthorized", { status: 401 });
          const delivered = await request.json();
          return Response.json({ outcomes: await runJobs(delivered.jobs, jobsForQueue(delivered.queue)) });
        })
      )
    );
  },
};
`;

type Delivery = { jobId: string; runId: string; attempts: number };
type WebhookCall = {
  url: string;
  signature: string | null;
  version: string | null;
  body: string;
};
type QueueTrigger = {
  name: string;
  maxConcurrency?: number | null;
  maxBatchSize?: number;
  deadLetterQueue?: string;
};

describe("JOBS queue job path in workerd", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const providerCalls: string[] = [];
  const webhookCalls: WebhookCall[] = [];
  const failingProviderTokens = new Set<string>();

  async function provider(request: {
    url: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }) {
    const { hostname, pathname } = new URL(request.url);
    const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    providerCalls.push(`${token} ${hostname}${pathname}`);
    const { Response } = await import("miniflare");
    if (pathname.startsWith("/webhook")) {
      webhookCalls.push({
        url: request.url,
        signature: request.headers.get("x-cal-signature-256"),
        version: request.headers.get("x-cal-webhook-version"),
        body: await request.text(),
      });
      if (pathname === "/webhook-down") return new Response("rejected", { status: 500 });
      return Response.json({ ok: true });
    }
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

  const deliveriesOf = async (runId: string) =>
    (await call<Delivery[]>("/deliveries")).filter((delivery) => delivery.runId === runId);
  const providerCallsOf = (token: string) => providerCalls.filter((entry) => entry.startsWith(`${token} `));
  const webhookCallsOf = (url: string) => webhookCalls.filter((entry) => entry.url === url);
  const taskRowsOf = async (runId: string) =>
    (
      await db
        .prepare('SELECT COUNT(*) AS "count" FROM "Task" WHERE "id" = ?')
        .bind(runId)
        .first<{ count: number }>()
    )?.count;
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

  async function seedBookingWebhook({
    userId,
    subscriberUrl,
    secret,
  }: {
    userId: number;
    subscriberUrl: string;
    secret: string | null;
  }) {
    await db.batch([
      db
        .prepare(
          'INSERT INTO "users" ("id", "uuid", "email", "username", "name", "timeZone", "locale") VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          userId,
          `webhook-user-${userId}`,
          `webhook-user-${userId}@example.invalid`,
          `webhook-user-${userId}`,
          "Webhook User",
          "UTC",
          "en"
        ),
      db
        .prepare('INSERT INTO "EventType" ("id", "title", "slug", "length", "userId") VALUES (?, ?, ?, ?, ?)')
        .bind(userId, "Webhook Event", `webhook-event-${userId}`, 30, userId),
      db
        .prepare(
          'INSERT INTO "Booking" ("id", "uid", "title", "responses", "startTime", "endTime", "userId", "eventTypeId") VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          userId,
          `webhook-booking-${userId}`,
          "Webhook booking",
          JSON.stringify({ name: "Webhook Booker", email: "booker@example.invalid" }),
          "2026-11-08T10:00:00.000+00:00",
          "2026-11-08T10:30:00.000+00:00",
          userId,
          userId
        ),
      db
        .prepare(
          'INSERT INTO "Webhook" ("id", "userId", "subscriberUrl", "eventTriggers", "secret", "active") VALUES (?, ?, ?, ?, ?, 1)'
        )
        .bind(`webhook-${userId}`, userId, subscriberUrl, JSON.stringify(["BOOKING_REQUESTED"]), secret),
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
    const queueBindings = {
      JOBS_WEBHOOKS: worker.env.JOBS_WEBHOOKS,
      JOBS_CALENDARS: worker.env.JOBS_CALENDARS,
      JOBS_NOTIFICATIONS: worker.env.JOBS_NOTIFICATIONS,
    };
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
              ...queueBindings,
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
            env: { DB, ...queueBindings },
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

    await expect.poll(async () => destinationCalendars(1), { timeout: 20_000 }).toEqual(["calendar-user-1"]);
    expect(await deliveriesOf(runId)).toEqual([{ jobId: CALENDAR_JOB_ID, runId, attempts: 1 }]);
    expect(await taskRowsOf(runId)).toBe(0);
    expect(providerCallsOf("user-1").length).toBeGreaterThan(0);
  });

  it("retries a throwing run with transport attempts until the budget is spent", async () => {
    const { runId } = await call<{ runId: string }>("/enqueue-failing", { userId: 3 });

    await expect.poll(() => deliveriesOf(runId), { timeout: 20_000 }).toHaveLength(3);
    expect((await deliveriesOf(runId)).map(({ attempts }) => attempts)).toEqual([1, 2, 3]);
    expect(await taskRowsOf(runId)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await deliveriesOf(runId)).toHaveLength(3);
    expect(providerCallsOf("").filter((entry) => entry.includes("/always-fails")).length).toBeGreaterThan(0);
  });

  it("retries a failing booking notification run until the budget is spent", async () => {
    const { runId } = await call<{ runId: string }>("/enqueue-booking", { bookingId: 999_999 });

    await expect.poll(() => deliveriesOf(runId), { timeout: 20_000 }).toHaveLength(3);
    expect((await deliveriesOf(runId)).map(({ attempts }) => attempts)).toEqual([1, 2, 3]);
    expect((await deliveriesOf(runId))[0].jobId).toBe(REQUEST_BOOKING_NOTIFICATIONS_JOB_ID);
    expect(await taskRowsOf(runId)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await deliveriesOf(runId)).toHaveLength(3);
  });

  it("keeps a swallowed provider failure terminal instead of retrying it", async () => {
    await seedUser(5);
    failingProviderTokens.add("user-5");

    const { runId } = await call<{ runId: string }>("/dispatch", { userId: 5 });

    await expect.poll(() => providerCallsOf("user-5").length, { timeout: 20_000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await deliveriesOf(runId)).toHaveLength(1);
  });

  it("delivers a webhook job through JOBS and records the completed attempt", async () => {
    const userId = 21;
    const subscriberUrl = "https://provider.test/webhook-delivered";
    await seedBookingWebhook({ userId, subscriberUrl, secret: "webhook-secret" });

    const { taskId } = await call<{ taskId: string }>("/dispatch-webhook", {
      operationId: "webhook-delivered",
      triggerEvent: "BOOKING_REQUESTED",
      bookingUid: `webhook-booking-${userId}`,
      eventTypeId: userId,
      userId,
      timestamp: new Date().toISOString(),
    });

    await expect.poll(() => webhookCallsOf(subscriberUrl), { timeout: 30_000 }).toHaveLength(1);
    const [delivery] = webhookCallsOf(subscriberUrl);
    expect(delivery.version).toBe("2021-10-20");
    expect(delivery.signature).toBe(
      createHmac("sha256", "webhook-secret").update(delivery.body).digest("hex")
    );
    expect(JSON.parse(delivery.body)).toMatchObject({
      triggerEvent: "BOOKING_REQUESTED",
      payload: { title: "Webhook booking" },
    });
    expect(await deliveriesOf(taskId)).toEqual([
      { jobId: WEBHOOK_DELIVERY_JOB_ID, runId: taskId, attempts: 1 },
    ]);
    expect(await taskRowsOf(taskId)).toBe(0);
  });

  it("keeps a webhook provider failure terminal instead of retrying it", async () => {
    const userId = 22;
    const subscriberUrl = "https://provider.test/webhook-down";
    await seedBookingWebhook({ userId, subscriberUrl, secret: null });

    const { taskId } = await call<{ taskId: string }>("/dispatch-webhook", {
      operationId: "webhook-provider-down",
      triggerEvent: "BOOKING_REQUESTED",
      bookingUid: `webhook-booking-${userId}`,
      eventTypeId: userId,
      userId,
      timestamp: new Date().toISOString(),
    });

    await expect.poll(() => webhookCallsOf(subscriberUrl), { timeout: 30_000 }).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(webhookCallsOf(subscriberUrl)).toHaveLength(1);
    expect(await deliveriesOf(taskId)).toHaveLength(1);
  });

  it("fails an invalid webhook payload without retrying", async () => {
    await call("/send-raw", {
      jobId: WEBHOOK_DELIVERY_JOB_ID,
      runId: "invalid-webhook-payload",
      payload: { operationId: "missing-trigger-event" },
      attempts: 1,
    });

    await expect.poll(() => deliveriesOf("invalid-webhook-payload"), { timeout: 20_000 }).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await deliveriesOf("invalid-webhook-payload")).toHaveLength(1);
  });

  it.each(["without-queue-binding", "without-async-opt-in"])("stays synchronous %s", async (worker) => {
    const userId = worker === "without-queue-binding" ? 9 : 10;
    await seedUser(userId);

    const { runId } = await call<{ runId: string }>("/dispatch", { userId }, worker);

    expect(runId).toMatch(/^sync_/);
    expect(await destinationCalendars(userId)).toEqual([`calendar-user-${userId}`]);
    expect(await deliveriesOf(runId)).toEqual([]);
  });

  it("falls back to synchronous when the send fails", async () => {
    await seedUser(11);

    const { runId } = await call<{ runId: string }>("/dispatch-broken-queue", { userId: 11 });

    expect(runId).toMatch(/^sync_/);
    expect(await destinationCalendars(11)).toEqual(["calendar-user-11"]);
    expect(await deliveriesOf(runId)).toEqual([]);
  });

  it("configures each job family with the source concurrency limit", async () => {
    const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
    const queueTriggers = (worker.triggers ?? []).filter(
      (trigger): trigger is QueueTrigger & { type: "queue" } => trigger.type === "queue"
    );

    expect(
      Object.fromEntries(queueTriggers.map((trigger) => [trigger.name, trigger.maxConcurrency]))
    ).toEqual({
      "calflare-jobs-webhooks": 25,
      "calflare-jobs-calendars": 10,
      "calflare-jobs-notifications": 20,
    });
    for (const trigger of queueTriggers) {
      expect(trigger.maxBatchSize).toBe(1);
      expect(trigger.deadLetterQueue).toBe("calflare-jobs-dlq");
    }
  });

  it("computes the same delays as Trigger's retry formula", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.37);
    // min(maxTimeout, (random + 1) * minTimeout * factor ** (attempt - 1)), none once attempts are spent.
    expect([1, 2, 3].map((attempt) => nextRetryDelayMs(calendarsTaskConfig.retry, attempt))).toEqual([
      82_200,
      164_400,
      undefined,
    ]);
    expect([1, 2, 3].map((attempt) => nextRetryDelayMs(webhookDeliveryTaskConfig.retry, attempt))).toEqual([
      41_100,
      82_200,
      undefined,
    ]);
    expect(nextRetryDelayMs({ maxAttempts: 10, randomize: false }, 8)).toBe(60_000);
    expect(nextRetryDelayMs(undefined, 2)).toBe(2_740);
    random.mockRestore();
  });
});
