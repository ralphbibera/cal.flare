import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCalCredentialsAuth } from "./cal-credentials-auth";

let mf: Miniflare;
let auth: ReturnType<typeof createCalCredentialsAuth>;
const origin = "https://calflare.test";
const cookieName = "__Secure-next-auth.callback-url";

beforeAll(async () => {
  mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "callback-test",
          compatibilityDate: "2026-11-04",
          env: { DB: { type: "d1", name: "callback-test", dev: { remote: false } } },
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
});

afterAll(async () => {
  await mf?.dispose();
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
