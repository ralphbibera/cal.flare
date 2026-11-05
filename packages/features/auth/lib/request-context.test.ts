import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

let mf: Miniflare;

beforeAll(async () => {
  const fixtures = new URL("./__tests__/fixtures/", import.meta.url);
  const modules: Record<string, { type: "esm"; contents: string }> = {};
  for (const [input, output] of [
    ["auth-request.worker.ts", "worker.js"],
    ["auth-request-reader.ts", "auth-request-reader.js"],
  ]) {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL(input, fixtures))],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      external: ["node:*", "./auth-request-reader.js"],
    });
    modules[output] = { type: "esm", contents: bundle.outputFiles[0].text };
  }
  mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "auth-request-context",
          compatibilityDate: "2026-11-04",
          compatibilityFlags: ["nodejs_compat"],
          manifest: { mainModule: "worker.js", modules },
          env: {
            DB: { type: "d1", name: "auth-context-first", dev: { remote: false } },
            SECOND: { type: "d1", name: "auth-context-second", dev: { remote: false } },
          },
        },
      },
    ],
  });
  for (const [binding, marker] of [
    ["DB", "first"],
    ["SECOND", "second"],
  ]) {
    const db = await mf.getD1Database(binding);
    await db.batch([
      db.prepare("CREATE TABLE context_marker (value TEXT NOT NULL)"),
      db.prepare("INSERT INTO context_marker VALUES (?)").bind(marker),
    ]);
  }
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

it("isolates native DB and secret bindings across requests, nested calls and separate server bundles", async () => {
  await Promise.all(
    Array.from({ length: 20 }, async (_, index) => {
      const marker = index % 2 === 0 ? "first" : "second";
      const response = await mf.dispatchFetch(`https://calflare.test/${marker}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("isolated");
    })
  );
});
