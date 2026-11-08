import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import type { MiniflareOptions } from "miniflare";
import { Miniflare } from "miniflare";
import {
  afterAll as vitestAfterAll,
  afterEach as vitestAfterEach,
  beforeAll as vitestBeforeAll,
  beforeEach as vitestBeforeEach,
  it as vitestIt,
  test as vitestTest,
} from "vitest";

type Workers = NonNullable<MiniflareOptions["workers"]>;
type WorkerEntry = Extract<Workers[number], { config: unknown }>;

type WorkerEnv = NonNullable<MiniflareD1Worker["env"]>;

export type MiniflareD1Worker = WorkerEntry["config"];
export type MiniflareD1Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

export type MiniflareD1Options = {
  /** Resolved `apps/web/cloudflare.config` worker, loaded by the suite so packages/testing stays below apps/web. */
  worker: MiniflareD1Worker | (() => MiniflareD1Worker | Promise<MiniflareD1Worker>);
  /** Extra Miniflare bindings for suites that query more than one D1 database. */
  env?: WorkerEnv;
  setupTimeout?: number;
};

export function setupMiniflareD1(options: MiniflareD1Options) {
  let directory: string | undefined;
  let runtime: Miniflare | undefined;
  let database: MiniflareD1Database | undefined;

  const db = () => {
    if (!database) throw new Error("Miniflare D1 is only available inside this fixture's hooks and tests");
    return database;
  };
  const miniflare = () => {
    if (!runtime) throw new Error("Miniflare is only available inside this fixture's hooks and tests");
    return runtime;
  };
  const run = <T>(callback: () => T): T => withD1Database({ DB: db() }, callback);
  const wrapped = (callback: () => unknown) => async () => {
    await run(callback);
  };

  vitestBeforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-d1-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const worker = typeof options.worker === "function" ? await options.worker() : options.worker;
    runtime = new Miniflare({
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
            env: { DB: worker.env.DB, ...options.env },
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
    database = await runtime.getD1Database("DB");
  }, options.setupTimeout);

  vitestAfterAll(async () => {
    await runtime?.dispose();
    runtime = undefined;
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  return {
    get db() {
      return db();
    },
    get runtime() {
      return miniflare();
    },
    run,
    it: (name: string, callback: () => unknown, timeout?: number) =>
      vitestIt(name, wrapped(callback), timeout),
    test: (name: string, callback: () => unknown, timeout?: number) =>
      vitestTest(name, wrapped(callback), timeout),
    beforeAll: (callback: () => unknown, timeout?: number) => vitestBeforeAll(wrapped(callback), timeout),
    beforeEach: (callback: () => unknown) => vitestBeforeEach(wrapped(callback)),
    afterEach: (callback: () => unknown) => vitestAfterEach(wrapped(callback)),
    afterAll: (callback: () => unknown, timeout?: number) => vitestAfterAll(wrapped(callback), timeout),
  };
}
