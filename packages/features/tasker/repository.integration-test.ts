import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TaskRepository } from "./repository";

type TaskFixture = {
  id: string;
  scheduledAt: Date;
  attempts?: number;
  maxAttempts?: number;
  succeededAt?: Date | null;
};

function timestamp(date: Date): string {
  return date.toISOString().replace("Z", "+00:00");
}

function minutes(count: number): number {
  return count * 60_000;
}

function optionalTimestamp(date: Date | null | undefined): string | null {
  if (!date) return null;
  return timestamp(date);
}

describe("task repository on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-tasker-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
    mf = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(persistTo, "v3"),
      workers: [
        {
          config: {
            name: worker.name,
            compatibilityDate: worker.compatibilityDate,
            compatibilityFlags: worker.compatibilityFlags,
            env: { DB: worker.env.DB },
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
              },
            },
          },
        },
      ],
    });
    db = await mf.getD1Database("DB");
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.prepare('DELETE FROM "Task"').run();
  });

  const repository = new TaskRepository({ prismaClient: prisma });
  const inD1 = <T>(callback: () => Promise<T>): Promise<T> => withD1Database({ DB: db }, callback);
  const dueIds = async (): Promise<string[]> =>
    (await inD1(() => repository.getNextBatch())).map((task) => task.id);

  async function seed(tasks: TaskFixture[]): Promise<void> {
    const insert = db.prepare(
      'INSERT INTO "Task" ("id", "updatedAt", "scheduledAt", "type", "payload", "attempts", "maxAttempts", "succeededAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (let index = 0; index < tasks.length; index += 50) {
      await db.batch(
        tasks
          .slice(index, index + 50)
          .map((task) =>
            insert.bind(
              task.id,
              timestamp(task.scheduledAt),
              timestamp(task.scheduledAt),
              "sendWebhook",
              "{}",
              task.attempts ?? 0,
              task.maxAttempts ?? 3,
              optionalTimestamp(task.succeededAt)
            )
          )
      );
    }
  }

  it("creates a due task with the pinned attempts and max-attempt defaults", async () => {
    const scheduledAt = new Date(Date.now() - minutes(1));
    const taskId = await inD1(() => repository.create("sendWebhook", '{"event":"created"}', { scheduledAt }));

    const [task] = await inD1(() => repository.getNextBatch());
    expect(task).toMatchObject({
      id: taskId,
      scheduledAt,
      type: "sendWebhook",
      payload: '{"event":"created"}',
      attempts: 0,
      maxAttempts: 3,
      succeededAt: null,
      lastError: null,
      lastFailedAttemptAt: null,
    });
  });

  it("selects only due tasks in schedule order, excluding succeeded, future and exhausted rows", async () => {
    const now = Date.now();
    await seed([
      { id: "later", scheduledAt: new Date(now - minutes(10)), attempts: 2 },
      { id: "earlier", scheduledAt: new Date(now - minutes(20)) },
      { id: "exhausted", scheduledAt: new Date(now - minutes(15)), attempts: 3 },
      { id: "over-budget", scheduledAt: new Date(now - minutes(15)), attempts: 4 },
      { id: "zero-budget", scheduledAt: new Date(now - minutes(15)), maxAttempts: 0 },
      {
        id: "succeeded",
        scheduledAt: new Date(now - minutes(15)),
        succeededAt: new Date(now - minutes(14)),
      },
      { id: "future", scheduledAt: new Date(now + minutes(60)) },
    ]);

    await expect(dueIds()).resolves.toEqual(["earlier", "later"]);
    await expect(dueIds()).resolves.toEqual(["earlier", "later"]);
    const [earlier] = await inD1(() => repository.getNextBatch());
    expect(earlier?.attempts).toBe(0);
    expect(earlier?.succeededAt).toBeNull();
    await expect(inD1(() => repository.countUpcoming())).resolves.toBe(2);
  });

  it("takes the earliest 1000 due tasks while counting every upcoming row", async () => {
    const now = Date.now();
    await seed(
      Array.from({ length: 1005 }, (_, index) => ({
        id: `bulk-${String(index).padStart(4, "0")}`,
        scheduledAt: new Date(now - (1005 - index) * 1000),
      }))
    );

    const batch = await inD1(() => repository.getNextBatch());
    expect(batch).toHaveLength(1000);
    expect(batch[0]?.id).toBe("bulk-0000");
    expect(batch.at(-1)?.id).toBe("bulk-0999");
    await expect(inD1(() => repository.countUpcoming())).resolves.toBe(1005);
  });

  it("retries without an interval by incrementing attempts and recording the failure", async () => {
    const scheduledAt = new Date(Date.now() - minutes(5));
    await seed([{ id: "retry", scheduledAt }]);

    const before = Date.now();
    const retried = await inD1(() => repository.retry({ taskId: "retry", lastError: "boom" }));
    const after = Date.now();

    expect(retried.attempts).toBe(1);
    expect(retried.lastError).toBe("boom");
    expect(retried.lastFailedAttemptAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(retried.lastFailedAttemptAt?.getTime()).toBeLessThanOrEqual(after);
    expect(retried.scheduledAt.getTime()).toBe(scheduledAt.getTime());
    await expect(dueIds()).resolves.toEqual(["retry"]);
  });

  it("reschedules a retry by the configured minimum interval", async () => {
    await seed([{ id: "retry-interval", scheduledAt: new Date(Date.now() - minutes(5)) }]);

    const before = Date.now();
    const retried = await inD1(() =>
      repository.retry({ taskId: "retry-interval", lastError: "later", minRetryIntervalMins: 5 })
    );
    const after = Date.now();

    expect(retried.attempts).toBe(1);
    expect(retried.lastFailedAttemptAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(retried.lastFailedAttemptAt?.getTime()).toBeLessThanOrEqual(after);
    expect(retried.scheduledAt.getTime()).toBe((retried.lastFailedAttemptAt?.getTime() ?? 0) + minutes(5));
    await expect(dueIds()).resolves.toEqual([]);
    await expect(inD1(() => repository.countUpcoming())).resolves.toBe(0);
  });

  it("exhausts a task on its final retry and reports it as failed", async () => {
    await seed([
      { id: "exhausts", scheduledAt: new Date(Date.now() - minutes(1)), attempts: 2, maxAttempts: 3 },
    ]);
    await expect(dueIds()).resolves.toEqual(["exhausts"]);

    const retried = await inD1(() => repository.retry({ taskId: "exhausts", lastError: "final failure" }));

    expect(retried.attempts).toBe(3);
    await expect(dueIds()).resolves.toEqual([]);
    await expect(inD1(() => repository.countUpcoming())).resolves.toBe(0);
    await expect(
      inD1(() => repository.getFailed()).then((tasks) => tasks.map((task) => task.id))
    ).resolves.toEqual(["exhausts"]);
    await expect(inD1(() => repository.countFailed())).resolves.toBe(1);
  });

  it("succeeds a task by incrementing attempts and excluding it from later batches", async () => {
    await seed([{ id: "succeeds", scheduledAt: new Date(Date.now() - minutes(1)) }]);

    const before = Date.now();
    const succeeded = await inD1(() => repository.succeed("succeeds"));
    const after = Date.now();

    expect(succeeded.attempts).toBe(1);
    expect(succeeded.succeededAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(succeeded.succeededAt?.getTime()).toBeLessThanOrEqual(after);
    await expect(dueIds()).resolves.toEqual([]);
    await expect(
      inD1(() => repository.getSucceeded()).then((tasks) => tasks.map((task) => task.id))
    ).resolves.toEqual(["succeeds"]);
    await expect(inD1(() => repository.countSucceeded())).resolves.toBe(1);
  });

  it("keeps the pinned attempt-equality filter, including rows that succeeded on their final attempt", async () => {
    const now = Date.now();
    await seed([
      { id: "exhausted", scheduledAt: new Date(now - minutes(1)), attempts: 3 },
      { id: "over-budget", scheduledAt: new Date(now - minutes(1)), attempts: 4 },
      { id: "under-budget", scheduledAt: new Date(now - minutes(1)), attempts: 2 },
      { id: "zero-budget", scheduledAt: new Date(now - minutes(1)), maxAttempts: 0 },
      {
        id: "succeeded-final",
        scheduledAt: new Date(now - minutes(1)),
        attempts: 1,
        maxAttempts: 1,
        succeededAt: new Date(now - 30_000),
      },
    ]);

    const failed = await inD1(() => repository.getFailed());
    expect(failed.map((task) => task.id).sort()).toEqual(["exhausted", "succeeded-final", "zero-budget"]);
    await expect(inD1(() => repository.countFailed())).resolves.toBe(3);
  });
});
