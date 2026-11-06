import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../cloudflare.config";
import { buildScheduleWorker } from "./__fixtures__/build-worker";

const API_KEY = "schedule-test-api-key";
const RECORDED_REQUEST_PREFIX = "schedule-test-request ";
const BEARER = "Bearer schedule-test-cron-secret";
const [{ schedule: DISPATCH_CRON }] = config.worker.triggers;
const FIRST_OF_MONTH_MIDNIGHT = "2026-11-01T00:00:00.000Z";

type RecordedRequest = { method: string; path: string; authorization: string | null; d1: boolean };

const workflowCall = (path: string): RecordedRequest => ({
  method: "POST",
  path,
  authorization: API_KEY,
  d1: true,
});
const vercelCall = (path: string): RecordedRequest => ({
  method: "GET",
  path,
  authorization: BEARER,
  d1: true,
});

const byPath = (a: RecordedRequest, b: RecordedRequest) => a.path.localeCompare(b.path);

describe("scheduled dispatch in workerd", () => {
  let directory: string;
  let workerSource: string;
  const runtimes: Miniflare[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-schedules-"));
    await buildScheduleWorker(join(directory, "bundle"));
    workerSource = await readFile(join(directory, "bundle", "worker.js"), "utf8");
  }, 120_000);

  afterAll(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function startWorker(vars: Record<string, string>) {
    const { worker } = config;
    let logs = "";
    const runtime = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(directory, "state"),
      handleStructuredLogs({ message }: { message: string }) {
        logs += `${message}\n`;
      },
      workers: [
        {
          config: {
            name: worker.name,
            compatibilityDate: worker.compatibilityDate,
            compatibilityFlags: worker.compatibilityFlags,
            assets: { ...worker.assets, directory },
            env: {
              DB: worker.env.DB,
              ASSETS: worker.env.ASSETS,
              ...Object.fromEntries(
                Object.entries(vars).map(([name, value]) => [name, { type: "text" as const, value }])
              ),
            },
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: workerSource } },
            },
          },
        },
      ],
    });
    runtimes.push(runtime);
    await runtime.ready;

    return {
      async trigger(cron: string, scheduledTime: string) {
        logs = "";
        const { outcome } = await (await runtime.getWorker()).scheduled({
          cron,
          scheduledTime: new Date(scheduledTime),
        });
        const requests = logs
          .split("\n")
          .filter((line) => line.startsWith(RECORDED_REQUEST_PREFIX))
          .map((line) => JSON.parse(line.slice(RECORDED_REQUEST_PREFIX.length)) as RecordedRequest);
        return { outcome, requests: requests.sort(byPath), logs };
      },
    };
  }

  it("calls every schedule due at the minute with its source method and authorization", async () => {
    const worker = await startWorker({ CRON_API_KEY: API_KEY, CRON_SECRET: "schedule-test-cron-secret" });

    const { outcome, requests } = await worker.trigger(DISPATCH_CRON, FIRST_OF_MONTH_MIDNIGHT);

    expect(outcome).toBe("ok");
    expect(requests).toEqual(
      [
        workflowCall("/api/cron/bookingReminder"),
        workflowCall("/api/cron/changeTimeZone"),
        workflowCall("/api/cron/syncAppMeta"),
        workflowCall("/api/cron/webhookTriggers"),
        vercelCall("/api/cron/calendar-subscriptions"),
        vercelCall("/api/cron/selected-calendars"),
        vercelCall("/api/tasks/cron"),
        vercelCall("/api/tasks/cleanup"),
      ].sort(byPath)
    );

    const offMinute = await worker.trigger(DISPATCH_CRON, "2026-11-06T03:07:00.000Z");
    expect(offMinute.requests).toEqual([
      workflowCall("/api/cron/webhookTriggers"),
      vercelCall("/api/tasks/cron"),
    ]);

    const cleanupHour = await worker.trigger(DISPATCH_CRON, "2026-11-06T03:00:00.000Z");
    expect(cleanupHour.requests.map(({ path }) => path)).toContain(
      "/api/cron/calendar-subscriptions-cleanup"
    );
    expect(cleanupHour.requests.map(({ path }) => path)).not.toContain("/api/tasks/cleanup");
  }, 60_000);

  it("rejects a cron with no bound schedules without calling any route", async () => {
    const worker = await startWorker({ CRON_API_KEY: API_KEY, CRON_SECRET: "schedule-test-cron-secret" });

    const { outcome, requests, logs } = await worker.trigger("*/7 * * * *", FIRST_OF_MONTH_MIDNIGHT);

    expect(outcome).toBe("exception");
    expect(requests).toEqual([]);
    expect(logs).toContain('No schedules are bound to cron "*/7 * * * *"');
  }, 60_000);

  it("still calls the other schedules when one route fails", async () => {
    const worker = await startWorker({
      CRON_API_KEY: API_KEY,
      CRON_SECRET: "schedule-test-cron-secret",
      SCHEDULE_TEST_FAILING_PATH: "/api/cron/bookingReminder",
    });

    const { outcome, requests, logs } = await worker.trigger(DISPATCH_CRON, FIRST_OF_MONTH_MIDNIGHT);

    expect(outcome).toBe("exception");
    expect(requests).toHaveLength(8);
    expect(logs.match(/^schedule-test-completed /gm)).toHaveLength(7);
    expect(logs).not.toContain("schedule-test-completed /api/cron/bookingReminder");
    expect(logs).toContain("Scheduled dispatch failed: POST /api/cron/bookingReminder responded 500");
  }, 60_000);

  it("skips workflow schedules without CRON_API_KEY and calls Vercel schedules without a secret", async () => {
    const worker = await startWorker({});

    const { requests } = await worker.trigger(DISPATCH_CRON, "2026-11-06T03:07:00.000Z");

    expect(requests).toEqual([{ method: "GET", path: "/api/tasks/cron", authorization: null, d1: true }]);
  }, 60_000);
});
