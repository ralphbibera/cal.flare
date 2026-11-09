import { createCalRequestAuth } from "@calcom/features/auth/lib/request-auth";
import type { AuthRequestConfiguration } from "@calcom/features/auth/lib/request-context";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthSignInService } from "./OAuthSignInService";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../apps/web/cloudflare.config")).default.worker,
});

const origin = "https://calflare.test";
const sessionCookie = "__Secure-better-auth.session_token";
const googleToken = "https://oauth2.googleapis.com/token";
const google = { clientId: "google-client", clientSecret: "google-secret" };
const microsoft = { clientId: "microsoft-client", clientSecret: "microsoft-secret" };

type Auth = ReturnType<typeof createCalRequestAuth>;

function auth(oauth: AuthRequestConfiguration["oauth"] = { google, microsoft }): Auth {
  return createCalRequestAuth({
    DB: d1.db,
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: `synthetic-signing-secret-${"x".repeat(32)}`,
    oauthSignIn: new OAuthSignInService(),
    oauth,
  });
}

const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = (claims: object) => `${base64Url({ alg: "RS256" })}.${base64Url(claims)}.signature`;

const claims = {
  sub: "google-sub-1",
  email: "person@calflare.test",
  email_verified: true,
  name: "Person Example",
  picture: "https://photos.test/p.png",
};

function mockGoogleToken(overrides: object = {}) {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url === googleToken)
      return new Response(
        JSON.stringify({
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid https://www.googleapis.com/auth/userinfo.email",
          id_token: idToken({ ...claims, ...overrides }),
        })
      );
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
  return {
    state: new URL(url).searchParams.get("state") ?? "",
    cookie: cookiesOf(response),
  };
}

const callback = (a: Auth, path: "google" | "azure-ad", query: Record<string, string>, cookie = "") =>
  a.handler(
    new Request(`${origin}/api/auth/callback/${path}?${new URLSearchParams(query)}`, {
      headers: { cookie },
    })
  );

const rows = async (table: string) => (await d1.db.prepare(`SELECT * FROM "${table}"`).all()).results;

function seedUser(values: Record<string, string | number | null>) {
  const entries = Object.entries({
    uuid: "oauth-user",
    username: "person",
    name: "Person",
    email: "person@calflare.test",
    ...values,
  });
  return d1.db
    .prepare(
      `INSERT INTO users(${entries.map(([column]) => `"${column}"`).join(",")})
       VALUES(${entries.map(() => "?").join(",")})`
    )
    .bind(...entries.map(([, value]) => value))
    .run();
}

d1.beforeEach(async () => {
  for (const table of [
    "AuthSession",
    "AuthVerification",
    "AuthUser",
    "AuthAccount",
    "Account",
    "Credential",
    "SelectedCalendar",
    "Profile",
    "Membership",
    "UserPassword",
  ]) {
    await d1.db.prepare(`DELETE FROM "${table}"`).run();
  }
  await d1.db.prepare("DELETE FROM users").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth account linking on D1", () => {
  d1.it("creates a new user and links the provider account", async () => {
    mockGoogleToken({ sub: "google-sub-new", email: "new@calflare.test", name: "New Person" });
    const a = auth();
    const { state, cookie } = await authorize(a, "google");

    const response = await callback(a, "google", { code: "auth-code", state }, cookie);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/bookings`);
    const [created] = (await rows("users")) as { id: number; identityProvider: string }[];
    expect(created).toMatchObject({
      email: "new@calflare.test",
      name: "New Person",
      identityProvider: "GOOGLE",
      identityProviderId: "google-sub-new",
    });
    expect(await rows("Account")).toMatchObject([
      { userId: created.id, provider: "google", providerAccountId: "google-sub-new" },
    ]);
    const session = (await rows("AuthSession")) as { calClaims: string }[];
    expect(JSON.parse(session[0].calClaims)).toMatchObject({ id: created.id, email: "new@calflare.test" });
    expect(cookiesOf(response)).toMatch(/session_token=/);
  });

  d1.it("converts a verified CAL user with the same email and links the provider account", async () => {
    await seedUser({
      id: 501,
      identityProvider: "CAL",
      emailVerified: "2024-01-01T00:00:00.000Z",
    });
    mockGoogleToken();
    const a = auth();
    const { state, cookie } = await authorize(a, "google");

    const response = await callback(a, "google", { code: "auth-code", state }, cookie);

    expect(response.headers.get("location")).toBe(`${origin}/bookings`);
    expect(await rows("users")).toHaveLength(1);
    expect(await rows("users")).toMatchObject([
      {
        id: 501,
        email: "person@calflare.test",
        identityProvider: "GOOGLE",
        identityProviderId: "google-sub-1",
      },
    ]);
    expect(await rows("Account")).toMatchObject([
      { userId: 501, provider: "google", providerAccountId: "google-sub-1" },
    ]);
    expect(await rows("AuthSession")).toHaveLength(1);
  });

  d1.it("reuses an already-linked provider account without duplicating the link", async () => {
    await seedUser({
      id: 502,
      identityProvider: "GOOGLE",
      identityProviderId: "google-sub-1",
      emailVerified: "2024-01-01T00:00:00.000Z",
    });
    await d1.db
      .prepare('INSERT INTO "Account"(id,userId,type,provider,providerAccountId) VALUES(?,?,?,?,?)')
      .bind("linked-account", 502, "oauth", "google", "google-sub-1")
      .run();
    mockGoogleToken();
    const a = auth();
    const { state, cookie } = await authorize(a, "google");

    const response = await callback(a, "google", { code: "auth-code", state }, cookie);

    expect(response.headers.get("location")).toBe(`${origin}/bookings`);
    expect(await rows("users")).toHaveLength(1);
    expect(await rows("Account")).toMatchObject([
      { id: "linked-account", userId: 502, provider: "google", providerAccountId: "google-sub-1" },
    ]);
    const session = (await rows("AuthSession")) as { calClaims: string }[];
    expect(JSON.parse(session[0].calClaims)).toMatchObject({ id: 502 });
  });

  d1.it("blocks an unverified CAL account from claiming the provider identity", async () => {
    await seedUser({ id: 503, identityProvider: "CAL", emailVerified: null });
    mockGoogleToken();
    const a = auth();
    const { state, cookie } = await authorize(a, "google");

    const response = await callback(a, "google", { code: "auth-code", state }, cookie);

    expect(response.headers.get("location")).toBe(`${origin}/auth/error?error=unverified-email`);
    expect(await rows("users")).toMatchObject([
      { id: 503, identityProvider: "CAL", identityProviderId: null },
    ]);
    expect(await rows("Account")).toEqual([]);
    expect(await rows("AuthSession")).toEqual([]);
    expect(cookiesOf(response)).not.toMatch(/session_token/);
  });

  d1.it("rejects a callback for a provider this instance does not offer", async () => {
    const requests = mockGoogleToken();
    const a = auth({ microsoft });
    const { state, cookie } = await authorize(a, "microsoft");

    const response = await callback(a, "google", { code: "auth-code", state }, cookie);

    expect(response.headers.get("location")).toBe(`${origin}/auth/error?error=OAuthCallback`);
    expect(requests).toEqual([]);
    expect(await rows("users")).toEqual([]);
    expect(await rows("Account")).toEqual([]);
    expect(await rows("AuthSession")).toEqual([]);
    const providers = await a.handler(new Request(`${origin}/api/auth/cal/oauth-providers`));
    expect(await providers.json()).toEqual({ providers: ["azure-ad"] });
  });
});
