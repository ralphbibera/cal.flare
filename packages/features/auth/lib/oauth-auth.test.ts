import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { OAuthSignInService } from "./OAuthSignInService";
import { createCalRequestAuth } from "./request-auth";
import type { AuthRequestConfiguration } from "./request-context";

const origin = "https://calflare.test";
const sessionCookie = "__Secure-better-auth.session_token";
const googleToken = "https://oauth2.googleapis.com/token";
const microsoftToken = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
let root: string;
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

function auth({ withService = true } = {}) {
  const config: AuthRequestConfiguration = {
    DB: db,
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: `synthetic-signing-secret-${"x".repeat(32)}`,
    ...(withService && { oauthSignIn: new OAuthSignInService() }),
    oauth: {
      google: { clientId: "google-client", clientSecret: "google-secret" },
      microsoft: { clientId: "microsoft-client", clientSecret: "microsoft-secret" },
    },
  };
  return createCalRequestAuth(config);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-oauth-"));
  await migrateD1({ persistTo: root });
  const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
  runtime = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(root, "v3"),
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
}, 120_000);

beforeEach(async () => {
  vi.stubEnv("CALENDSO_ENCRYPTION_KEY", "synthetic-encryption-key-0123456789");
  for (const table of [
    "AuthSession",
    "AuthVerification",
    "AuthUser",
    "Credential",
    "SelectedCalendar",
    "Account",
  ]) {
    await db.prepare(`DELETE FROM "${table}"`).run();
  }
  await db.prepare("DELETE FROM users").run();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

type Auth = ReturnType<typeof createCalRequestAuth>;
const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = (claims: object) => `${base64Url({ alg: "RS256" })}.${base64Url(claims)}.signature`;

function mockProvider(tokenUrl: string, tokenResponse: object) {
  const requests: { url: string; body: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url === tokenUrl) return new Response(JSON.stringify(tokenResponse));
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/calendars"))
      return new Response(JSON.stringify({ value: [{ id: "graph-default", isDefaultCalendar: true }] }));
    return new Response("not found", { status: 404 });
  });
  return requests;
}

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

async function authorize(a: Auth, provider: "google" | "microsoft", callbackURL = "/bookings") {
  const response = await a.handler(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider, callbackURL }),
    })
  );
  const { url } = (await response.json()) as { url: string };
  const authorizeUrl = new URL(url);
  return {
    response,
    authorizeUrl,
    state: authorizeUrl.searchParams.get("state") ?? "",
    cookie: cookiesOf(response),
  };
}

const callback = (a: Auth, path: "google" | "azure-ad", query: Record<string, string>, cookie = "") =>
  a.handler(
    new Request(`${origin}/api/auth/callback/${path}?${new URLSearchParams(query)}`, {
      headers: { cookie },
    })
  );

const googleClaims = {
  sub: "google-sub-1",
  email: "person@calflare.test",
  email_verified: true,
  name: "Person Example",
  picture: "https://photos.test/p.png",
};
const azureClaims = {
  sub: "azure-sub-1",
  oid: "azure-oid-1",
  tid: "tenant",
  email: "person@calflare.test",
  name: "Person Example",
  xms_edov: true,
};
const azureScope = "openid profile email User.Read Calendars.Read Calendars.ReadWrite";

const rows = async (table: string) => (await db.prepare(`SELECT * FROM "${table}"`).all()).results;
const seedUser = (columns: Record<string, string | number | null>) => {
  const entries = Object.entries({ uuid: "oauth-user", email: "person@calflare.test", ...columns });
  return db
    .prepare(
      `INSERT INTO users(${entries.map(([column]) => `"${column}"`).join(",")}) VALUES(${entries.map(() => "?").join(",")})`
    )
    .bind(...entries.map(([, value]) => value))
    .run();
};

describe("OAuth authorize redirect", () => {
  it("sends Google to its authorize endpoint with the source scopes, the registered redirect URI and PKCE", async () => {
    const { response, authorizeUrl } = await authorize(auth(), "google");

    expect(response.status).toBe(200);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/google`);
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      [
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
      ].join(" ")
    );
    expect(authorizeUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizeUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("google-client");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("sends Microsoft to the common tenant with the source scopes and the azure-ad redirect URI", async () => {
    const { authorizeUrl } = await authorize(auth(), "microsoft");

    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/azure-ad`);
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "openid profile email User.Read Calendars.Read Calendars.ReadWrite offline_access"
    );
    expect(authorizeUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("keeps social sign-in off for a caller that supplies no OAuth sign-in service", async () => {
    const response = await auth({ withService: false }).handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ provider: "google", callbackURL: "/bookings" }),
      })
    );

    expect(response.status).toBe(404);
  });

  it("rejects an id token sign-in, whose native session would carry no Cal claims", async () => {
    const response = await auth().handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ provider: "google", idToken: { token: idToken(googleClaims) } }),
      })
    );

    expect(response.status).toBe(400);
    expect(cookiesOf(response)).not.toMatch(/session_token/);
    expect(await rows("AuthSession")).toEqual([]);
  });
});

describe("OAuth callback on migrated D1", () => {
  it("creates the user and a Cal session for a first Google sign-in", async () => {
    const a = auth();
    const requests = mockProvider(googleToken, {
      access_token: "google-access",
      refresh_token: "google-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope:
        "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
      id_token: idToken(googleClaims),
    });
    const { state, cookie } = await authorize(a, "google");

    const response = await callback(a, "google", { code: "auth-code", state }, cookie);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/bookings`);
    const session = cookiesOf(response);
    expect(session).toMatch(new RegExp(`${sessionCookie}=.+`));
    const exchange = new URLSearchParams(requests.find((request) => request.url === googleToken)?.body);
    expect(exchange.get("redirect_uri")).toBe(`${origin}/api/auth/callback/google`);
    expect(exchange.get("code_verifier")).toBeTruthy();

    const created = await db
      .prepare(
        "SELECT id,username,name,email,emailVerified,identityProvider,identityProviderId,creationSource,avatarUrl FROM users"
      )
      .first<Record<string, string | number | null>>();
    expect(created).toMatchObject({
      name: "Person Example",
      email: "person@calflare.test",
      identityProvider: "GOOGLE",
      identityProviderId: "google-sub-1",
      creationSource: "webapp",
      avatarUrl: "https://photos.test/p.png",
    });
    expect(created?.emailVerified).not.toBeNull();
    expect(created?.username).toMatch(/^person-example-[a-z0-9]{6}$/);
    expect(await rows("Account")).toMatchObject([
      {
        userId: created?.id,
        provider: "google",
        providerAccountId: "google-sub-1",
        type: "oauth",
        access_token: "google-access",
        refresh_token: "google-refresh",
      },
    ]);
    expect(await rows("AuthAccount")).toEqual([]);

    const current = await a.handler(
      new Request(`${origin}/api/auth/get-session`, { headers: { cookie: session } })
    );
    expect(await current.json()).toMatchObject({ user: { id: created?.id, email: "person@calflare.test" } });
  });

  it("signs an existing Azure AD user in and installs Outlook with the default calendar", async () => {
    const a = auth();
    await db
      .prepare('INSERT OR IGNORE INTO "App"(slug,dirName,updatedAt,enabled) VALUES(?,?,?,1)')
      .bind("office365-calendar", "office365calendar", "2024-01-01T00:00:00.000Z")
      .run();
    await seedUser({
      id: 321,
      username: "person",
      name: "Person",
      emailVerified: "2024-01-01T00:00:00.000Z",
      identityProvider: "AZUREAD",
      identityProviderId: "azure-sub-1",
    });
    mockProvider(microsoftToken, {
      access_token: "azure-access",
      refresh_token: "azure-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope: azureScope,
      id_token: idToken(azureClaims),
    });
    const { state, cookie } = await authorize(a, "microsoft", "/event-types");

    const response = await callback(a, "azure-ad", { code: "auth-code", state }, cookie);

    expect(response.headers.get("location")).toBe(`${origin}/event-types`);
    expect(await rows("users")).toHaveLength(1);
    const current = await a.handler(
      new Request(`${origin}/api/auth/get-session`, { headers: { cookie: cookiesOf(response) } })
    );
    expect(await current.json()).toMatchObject({ user: { id: 321, username: "person" } });
    expect(await rows("Account")).toMatchObject([
      { userId: 321, provider: "azure-ad", providerAccountId: "azure-sub-1", access_token: "azure-access" },
    ]);
    expect(await rows("Credential")).toMatchObject([{ userId: 321, appId: "office365-calendar" }]);
    expect(await rows("SelectedCalendar")).toMatchObject([
      { userId: 321, integration: "office365_calendar", externalId: "graph-default" },
    ]);
  });

  it("sends a two-factor user to the login page with a signed totp token and no session", async () => {
    const a = auth();
    await seedUser({
      id: 322,
      username: "person",
      name: "Person",
      emailVerified: "2024-01-01T00:00:00.000Z",
      identityProvider: "GOOGLE",
      identityProviderId: "google-sub-1",
      twoFactorEnabled: 1,
    });
    mockProvider(googleToken, {
      access_token: "google-access",
      expires_in: 3600,
      scope: "openid",
      id_token: idToken(googleClaims),
    });
    const { state, cookie } = await authorize(a, "google");

    const response = await callback(a, "google", { code: "auth-code", state }, cookie);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${origin}/auth/login`);
    expect(location.searchParams.get("totp")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(cookiesOf(response)).not.toMatch(/session_token/);
    expect(await rows("AuthSession")).toEqual([]);
  });

  it("sends an Azure AD sign-in without a verified domain to the unverified-email error", async () => {
    const a = auth();
    mockProvider(microsoftToken, {
      access_token: "azure-access",
      expires_in: 3600,
      scope: azureScope,
      id_token: idToken({ ...azureClaims, xms_edov: undefined }),
    });
    const { state, cookie } = await authorize(a, "microsoft");

    const response = await callback(a, "azure-ad", { code: "auth-code", state }, cookie);

    expect(response.headers.get("location")).toBe(`${origin}/auth/error?error=unverified-email`);
    expect(await rows("users")).toEqual([]);
    expect(cookiesOf(response)).not.toMatch(/session_token/);
  });

  it("rejects a callback whose state was never issued", async () => {
    const a = auth();
    const requests = mockProvider(googleToken, { access_token: "x", id_token: idToken(googleClaims) });

    const response = await callback(a, "google", { code: "auth-code", state: "forged-state" });

    expect(response.headers.get("location")).toBe(`${origin}/auth/error?error=OAuthCallback`);
    expect(requests).toEqual([]);
    expect(cookiesOf(response)).not.toMatch(/session_token/);
    expect(await rows("users")).toEqual([]);
  });

  it("rejects a callback without the browser state cookie even with a real state", async () => {
    const a = auth();
    const requests = mockProvider(googleToken, { access_token: "x", id_token: idToken(googleClaims) });
    const { state } = await authorize(a, "google");

    const response = await callback(a, "google", { code: "auth-code", state });

    expect(response.headers.get("location")).toBe(`${origin}/auth/error?error=OAuthCallback`);
    expect(requests).toEqual([]);
    expect(await rows("AuthSession")).toEqual([]);
  });

  it("reports a provider error instead of signing in", async () => {
    const a = auth();
    const { state, cookie } = await authorize(a, "google");

    const response = await callback(a, "google", { error: "access_denied", state }, cookie);

    expect(response.headers.get("location")).toBe(`${origin}/auth/error?error=OAuthCallback`);
    expect(await rows("AuthSession")).toEqual([]);
  });

  it("does not serve the native Microsoft callback, whose session would carry no Cal claims", async () => {
    const response = await auth().handler(
      new Request(`${origin}/api/auth/callback/microsoft?code=c&state=s`)
    );

    expect(response.status).toBe(404);
  });
});
