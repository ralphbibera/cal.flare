import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_PROCESS_ID, clientProcessPolyfill, publicEnvironmentValues } from "./client-process";

type Consumer = "client" | "server";

function pluginContext(consumer: Consumer) {
  return { environment: { config: { consumer } } };
}

async function loadClientProcessShim() {
  const plugin = clientProcessPolyfill();
  const resolveId = plugin.resolveId as unknown as (this: unknown, source: string) => string | undefined;
  const load = plugin.load as unknown as (this: unknown, id: string) => string | undefined;

  expect(resolveId.call(pluginContext("client"), "node:process")).toBe(CLIENT_PROCESS_ID);
  expect(resolveId.call(pluginContext("client"), "process")).toBe(CLIENT_PROCESS_ID);
  expect(resolveId.call(pluginContext("server"), "node:process")).toBeUndefined();

  const code = load.call(pluginContext("client"), CLIENT_PROCESS_ID);
  if (!code) throw new Error("Client process shim did not load");

  const module = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  return { code, module };
}

describe("client process shim", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes public variables but never server-only variables or secrets", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEBAPP_URL", "http://127.0.0.1:3000");
    vi.stubEnv("DAILY_API_KEY", "daily-secret-value");
    vi.stubEnv("NEXTAUTH_SECRET", "auth-secret-value");
    vi.stubEnv("CALENDSO_ENCRYPTION_KEY", "encryption-secret-value");

    const { code, module } = await loadClientProcessShim();

    expect(module.default.env.NEXT_PUBLIC_WEBAPP_URL).toBe("http://127.0.0.1:3000");
    expect(module.default.env.DAILY_API_KEY).toBeUndefined();
    expect(module.default.env.NEXTAUTH_SECRET).toBeUndefined();
    expect(module.default.env.CALENDSO_ENCRYPTION_KEY).toBeUndefined();
    expect(module.default.browser).toBe(true);

    expect(code).not.toContain("daily-secret-value");
    expect(code).not.toContain("auth-secret-value");
    expect(code).not.toContain("encryption-secret-value");
  });

  it("only copies allowlisted public variables", () => {
    expect(
      publicEnvironmentValues({
        NEXT_PUBLIC_WEBAPP_URL: "http://127.0.0.1:3000",
        DATABASE_URL: "postgres://secret",
        NEXTAUTH_SECRET: "secret",
        NEXT_PUBLIC_NOT_ALLOWLISTED: "leak",
      })
    ).toEqual({ NEXT_PUBLIC_WEBAPP_URL: "http://127.0.0.1:3000" });
  });
});
