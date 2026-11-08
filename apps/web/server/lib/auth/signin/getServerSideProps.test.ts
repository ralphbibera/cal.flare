import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "GOOGLE_API_CREDENTIALS",
  "GOOGLE_LOGIN_ENABLED",
  "MS_GRAPH_CLIENT_ID",
  "MS_GRAPH_CLIENT_SECRET",
  "OUTLOOK_LOGIN_ENABLED",
] as const;

function configureGoogle() {
  vi.stubEnv("GOOGLE_LOGIN_ENABLED", "true");
  vi.stubEnv(
    "GOOGLE_API_CREDENTIALS",
    JSON.stringify({ web: { client_id: "google-client", client_secret: "google-secret" } })
  );
}

function configureAzure() {
  vi.stubEnv("OUTLOOK_LOGIN_ENABLED", "true");
  vi.stubEnv("MS_GRAPH_CLIENT_ID", "microsoft-client");
  vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "microsoft-secret");
}

async function loadProviders() {
  vi.resetModules();
  const { getServerSideProps } = await import("./getServerSideProps");
  const { props } = await getServerSideProps();
  return props.providers;
}

describe("auth signin providers", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("offers Google when only Google is configured", async () => {
    configureGoogle();

    expect(await loadProviders()).toEqual([{ id: "google", name: "Google" }]);
  });

  it("offers Azure AD when only Azure is configured", async () => {
    configureAzure();

    expect(await loadProviders()).toEqual([{ id: "microsoft", name: "Azure AD" }]);
  });

  it("offers both when both are configured", async () => {
    configureGoogle();
    configureAzure();

    expect(await loadProviders()).toEqual([
      { id: "google", name: "Google" },
      { id: "microsoft", name: "Azure AD" },
    ]);
  });

  it("offers none when no provider is configured", async () => {
    expect(await loadProviders()).toEqual([]);
  });
});
