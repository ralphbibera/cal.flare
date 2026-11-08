import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { createCalCredentialsAuth } from "./cal-credentials-auth";

let mf: Miniflare;
let directory: string;
let auth: ReturnType<typeof createCalCredentialsAuth>;
const origin = "https://calflare.test";
const cookieName = "__Secure-next-auth.callback-url";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "calflare-callback-test-"));
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
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response(); } };",
              },
            },
          },
        },
      },
    ],
  });
  auth = createCalCredentialsAuth({
    DB: await mf.getD1Database("DB"),
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: "synthetic-callback-test-only-secret-0123456789",
  });
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it.each([
  ["/bookings", `${origin}/bookings`],
  ["https://calflare.test:9443/bookings", "https://calflare.test:9443/bookings"],
  ["http://calflare.test/bookings", "http://calflare.test/bookings"],
  ["https://other.test/bookings", origin],
  ["ftp://calflare.test/bookings", origin],
  ["file://calflare.test/bookings", origin],
  ["invalid URL", origin],
])("validates query and cookie callback %s before navigation", async (target, expected) => {
  for (const source of ["query", "cookie"]) {
    const query = source === "query" ? `?callbackUrl=${encodeURIComponent(target)}` : "";
    const response = await auth.handler(
      new Request(`${origin}/api/auth/signin${query}`, {
        headers: source === "cookie" ? { cookie: `${cookieName}=${encodeURIComponent(target)}` } : {},
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/auth/login?callbackUrl=${encodeURIComponent(expected)}`);
    const stored = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${cookieName}=`));
    if (target !== expected || source === "query") {
      expect(stored?.split(";")[0]).toBe(`${cookieName}=${encodeURIComponent(expected)}`);
    }
  }
});
