import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  IS_SELF_HOSTED: false,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [] }),
}));

describe("team logo lookup", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-logo-properties-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../cloudflare.config")).default;
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
    db = await runtime.getD1Database("DB");
    await db
      .prepare(`INSERT INTO "Team" ("name", "slug", "isOrganization", "metadata", "appLogo") VALUES
      ('Legacy organization', 'legacy', 0, '{"isOrganization":true}', 'http://app.cal.local:3000/legacy.svg'),
      ('Ordinary team', 'ordinary', 0, '{"isOrganization":"true"}', 'http://app.cal.local:3000/ordinary.svg'),
      ('Missing metadata', 'missing', 0, '{}', 'http://app.cal.local:3000/missing.svg'),
      ('Null metadata', 'null', 0, null, 'http://app.cal.local:3000/null.svg')`)
      .run();
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    "legacy",
    "ordinary",
    "missing",
    "null",
  ])("keeps organization-only filtering disabled for the existing %s route", async (slug) => {
    const body = `<svg>${slug}</svg>`;
    const fetchLogo = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/svg+xml" } }));
    try {
      const request = new NextRequest("http://app.cal.local:3000/api/logo", {
        headers: { host: `${slug}.cal.local:3000` },
      });
      const response = await withD1Database({ DB: db }, () => GET(request, { params: Promise.resolve({}) }));
      expect(fetchLogo).toHaveBeenCalledWith(`http://app.cal.local:3000/${slug}.svg`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    } finally {
      fetchLogo.mockRestore();
    }
  });
});
