import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Miniflare } from "miniflare";
import { runSeed } from "../../scripts/seed";
import { ErrorCode } from "../lib/errorCodes";
import { ErrorWithCode } from "../lib/errors";
import { withD1Database } from "./d1";
import { migrateD1 } from "./migrate-d1.mjs";

const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));

const defaultPersistTo = join(webRoot, ".cloudflare/state");

// Same storage the web Worker's local dev session opens, so `bun run dev` sees the seeded rows.
async function openLocalD1(persistTo = defaultPersistTo) {
  const { worker } = (await import("../../apps/web/cloudflare.config")).default;
  const mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(resolve(persistTo), "v3"),
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
  return { mf, db: await mf.getD1Database("DB") };
}

async function seedD1({ persistTo = defaultPersistTo }: { persistTo?: string } = {}) {
  const migrations = await migrateD1({ persistTo });
  const { mf, db } = await openLocalD1(persistTo);
  try {
    await withD1Database({ DB: db }, runSeed);
    return migrations;
  } finally {
    await mf.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { "local-only": { type: "boolean" }, "persist-to": { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    if (!values["local-only"]) {
      throw new ErrorWithCode(
        ErrorCode.Forbidden,
        "The D1 seed requires --local-only; remote seeding is unavailable"
      );
    }
    process.stdout.write(`${JSON.stringify(await seedD1({ persistTo: values["persist-to"] }))}\n`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export { openLocalD1, seedD1 };
