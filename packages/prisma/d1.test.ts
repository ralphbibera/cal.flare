import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("D1 request context", () => {
  const mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "d1-request-context",
          compatibilityDate: "2026-11-04",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
          env: {
            FIRST: { type: "d1", name: "context-first", dev: { remote: false } },
            SECOND: { type: "d1", name: "context-second", dev: { remote: false } },
          },
        },
      },
    ],
  });
  type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;
  let first: Database;
  let second: Database;

  beforeAll(async () => {
    [first, second] = await Promise.all([mf.getD1Database("FIRST"), mf.getD1Database("SECOND")]);
    for (const [db, marker] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      await db.batch([
        db.prepare("CREATE TABLE context_marker (value TEXT NOT NULL)"),
        db.prepare("INSERT INTO context_marker VALUES (?)").bind(marker),
      ]);
    }
  });

  afterAll(() => mf.dispose());

  async function separateModules() {
    vi.resetModules();
    const entry = await import("./d1");
    vi.resetModules();
    return { entry, route: await import("./d1") };
  }

  it("keeps the active binding visible across separately evaluated server modules", async () => {
    const { entry, route } = await separateModules();
    await entry.withD1Database({ DB: first }, async () => {
      expect(route.getD1Database()).toBe(first);
      expect(await route.getD1Database().prepare("SELECT value FROM context_marker").first("value")).toBe(
        "first"
      );
    });
    expect(() => route.getD1Database()).toThrow("D1 request binding is required");
  });

  it("isolates overlapping requests and restores the outer binding after nested work", async () => {
    const { entry, route } = await separateModules();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const db = index % 2 === 0 ? first : second;
        const marker = index % 2 === 0 ? "first" : "second";
        return entry.withD1Database({ DB: db }, async () => {
          await Promise.resolve();
          expect(await route.getD1Database().prepare("SELECT value FROM context_marker").first("value")).toBe(
            marker
          );
          entry.withD1Database({ DB: second }, () => expect(route.getD1Database()).toBe(second));
          expect(route.getD1Database()).toBe(db);
        });
      })
    );
    expect(() => entry.getD1Database()).toThrow("D1 request binding is required");
  });
});
