import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { AuthEnv } from "../src/server/auth.ts";
import { accessToken, beginLogin, finishLogin, logout, requireOwner } from "../src/server/auth.ts";
import { encryptionKey, seal, unseal } from "../src/server/secrets.ts";

const platform = await getPlatformProxy<{ DB: D1Database }>({
  configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  persist: false,
  remoteBindings: false,
});
const realFetch = globalThis.fetch;
const env: AuthEnv = {
  DB: platform.env.DB,
  PUBLIC_ORIGIN: "https://calendar.example.com",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_OWNER_EMAIL: "owner@example.com",
  TOKEN_ENCRYPTION_KEY: btoa("k".repeat(32)),
};
const db = env.DB;
let requests = 0;
const challenges = new Map<string, string>();
let identity: unknown = {
  sub: "pinned-subject",
  email: "owner@example.com",
  email_verified: true,
  name: "Organizer",
};
let tokenReply: Record<string, unknown> = {
  access_token: "access-secret",
  refresh_token: "refresh-secret",
  token_type: "Bearer",
  expires_in: 3600,
  scope:
    "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
};
globalThis.fetch = async (input, init) => {
  requests++;
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    assert.equal(init?.method, "POST");
    const data = new URLSearchParams(String(init.body));
    if (data.get("grant_type") === "authorization_code") {
      assert.equal(data.get("redirect_uri"), `${env.PUBLIC_ORIGIN}/api/auth/callback`);
      assert.equal(data.get("code_verifier")?.length, 43);
      assert.equal(
        createHash("sha256")
          .update(data.get("code_verifier") ?? "")
          .digest("base64url"),
        challenges.get(data.get("code") ?? ""),
        "The exchanged verifier must match this attempt's S256 challenge"
      );
    }
    return Response.json(tokenReply);
  }
  assert.equal(url, "https://openidconnect.googleapis.com/v1/userinfo");
  assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${tokenReply.access_token}`);
  return Response.json(identity);
};
async function attempt() {
  const response = await beginLogin(env, new Request(`${env.PUBLIC_ORIGIN}/api/auth/login`));
  const url = new URL(response.headers.get("Location") ?? "");
  const cookie = response.headers.get("Set-Cookie")?.split(";")[0] ?? "";
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), `${env.PUBLIC_ORIGIN}/api/auth/callback`);
  assert.match(response.headers.get("Set-Cookie") ?? "", /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const code = `test-code-${challenges.size}`;
  challenges.set(code, url.searchParams.get("code_challenge") ?? "");
  const callback = `${env.PUBLIC_ORIGIN}/api/auth/callback?state=${url.searchParams.get("state")}&code=${code}`;
  return { callback, cookie, state: url.searchParams.get("state") ?? "" };
}
async function callback(data: Awaited<ReturnType<typeof attempt>>) {
  return finishLogin(env, new Request(data.callback, { headers: { Cookie: data.cookie } }));
}
try {
  const migration = await readFile(new URL("../migrations/0001_identity.sql", import.meta.url), "utf8");
  await db.batch(
    migration
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql))
  );
  await assert.rejects(beginLogin(env, new Request("https://attacker.example/api/auth/login")), /origin/);
  await assert.rejects(
    beginLogin({ ...env, TOKEN_ENCRYPTION_KEY: "invalid" }, new Request(env.PUBLIC_ORIGIN)),
    /base64/
  );
  await assert.rejects(
    beginLogin({ ...env, PUBLIC_ORIGIN: "http://public.example" }, new Request("http://public.example")),
    /configuration/
  );
  const bound = await attempt();
  await assert.rejects(finishLogin(env, new Request(bound.callback)), /binding/);
  await assert.rejects(
    finishLogin(env, new Request(bound.callback, { headers: { Cookie: `flare_oauth=${"x".repeat(43)}` } })),
    /consumed/
  );
  assert.equal(requests, 0, "Unbound OAuth callbacks must not exchange a code");
  await db.prepare("UPDATE oauth_attempt SET expires_at = 0").run();
  await assert.rejects(callback(bound), /consumed/);
  assert.equal(requests, 0, "Expired OAuth callbacks must not exchange a code");

  identity = { sub: "attacker", email: "owner@example.com", email_verified: false };
  const unverified = await attempt();
  await assert.rejects(callback(unverified), /verified Google owner/);
  const afterFailure = requests;
  await assert.rejects(callback(unverified), /consumed/);
  assert.equal(requests, afterFailure, "An exchanged state must never exchange again");
  assert.equal(await db.prepare("SELECT id FROM owner").first(), null);
  identity = { sub: "attacker", email: "other@example.com", email_verified: true };
  await assert.rejects(callback(await attempt()), /verified Google owner/);
  identity = { sub: "pinned-subject", email: "OWNER@example.com", email_verified: true, name: "Organizer" };
  const fullConsent = tokenReply;
  for (const scope of [
    undefined,
    "openid email profile",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/calendar.readonly",
  ]) {
    tokenReply = { ...fullConsent, scope };
    const partial = await attempt();
    await assert.rejects(callback(partial), /Calendar permissions/);
    await assert.rejects(callback(partial), /consumed/);
    assert.equal(await db.prepare("SELECT id FROM owner").first(), null);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM owner_session").first<{ n: number }>())?.n, 0);
  }
  tokenReply = fullConsent;
  const success = await callback(await attempt());
  const sessionCookie =
    success.headers.getSetCookie().find((value) => value.startsWith("flare_session=")) ?? "";
  assert.match(sessionCookie, /HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
  const request = new Request(env.PUBLIC_ORIGIN, { headers: { Cookie: sessionCookie.split(";")[0] } });
  assert.deepEqual(await requireOwner(env, request), {
    id: "owner",
    email: "owner@example.com",
    name: "Organizer",
  });
  const session = await db
    .prepare("SELECT token_hash, expires_at FROM owner_session")
    .first<{ token_hash: string; expires_at: number }>();
  assert.ok(session);
  assert.ok(
    !sessionCookie.includes(session.token_hash),
    "Only a hash of the opaque session belongs in storage"
  );
  assert.ok(session.expires_at > Date.now() + 604_790_000);
  await requireOwner(env, request);
  assert.equal(
    (await db.prepare("SELECT expires_at FROM owner_session").first<{ expires_at: number }>())?.expires_at,
    session.expires_at,
    "Reading a session must not slide its deadline"
  );
  const connection = await db
    .prepare("SELECT ciphertext FROM google_connection")
    .first<{ ciphertext: string }>();
  assert.ok(connection);
  assert.ok(
    !connection.ciphertext.includes("access-secret") && !connection.ciphertext.includes("refresh-secret")
  );
  const key = await encryptionKey(env.TOKEN_ENCRYPTION_KEY);
  await assert.rejects(unseal(key, connection.ciphertext, "oauth-pkce"), /authenticated/);
  await assert.rejects(
    unseal(key, `${connection.ciphertext.slice(0, -4)}AAAA`, "google:owner"),
    /authenticated/
  );

  identity = { sub: "replacement-subject", email: "owner@example.com", email_verified: true };
  await assert.rejects(callback(await attempt()), /pinned owner/);
  assert.equal(
    (await db.prepare("SELECT google_sub FROM owner").first<{ google_sub: string }>())?.google_sub,
    "pinned-subject"
  );
  assert.equal((await db.prepare("SELECT count(*) AS n FROM owner_session").first<{ n: number }>())?.n, 1);
  identity = { sub: "pinned-subject", email: "owner@example.com", email_verified: true };
  env.TOKEN_ENCRYPTION_KEY = btoa("r".repeat(32));
  await callback(await attempt());
  const recovered = await db
    .prepare("SELECT ciphertext FROM google_connection")
    .first<{ ciphertext: string }>();
  assert.ok(recovered);
  assert.equal(
    JSON.parse(
      await unseal(await encryptionKey(env.TOKEN_ENCRYPTION_KEY), recovered.ciphertext, "google:owner")
    ).refresh,
    "refresh-secret",
    "Fresh Google consent must recover without decrypting the old credential"
  );
  tokenReply = {
    access_token: "second-access",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/calendar",
  };
  const secondLogin = await callback(await attempt());
  const secondSession =
    secondLogin.headers
      .getSetCookie()
      .find((value) => value.startsWith("flare_session="))
      ?.split(";")[0] ?? "";
  const refreshKey = await encryptionKey(env.TOKEN_ENCRYPTION_KEY);
  const beforeCachedAccess = requests;
  assert.equal(await accessToken(env), "second-access");
  assert.equal(requests, beforeCachedAccess, "A usable stored token must not trigger refresh");
  const beforeRace = await db.prepare("SELECT count(*) AS n FROM owner_session").first<{ n: number }>();
  const beforeVersion = await db
    .prepare("SELECT version FROM google_connection")
    .first<{ version: number }>();
  const raceAttempts = await Promise.all([attempt(), attempt()]);
  const loginFetch = globalThis.fetch;
  let arrivals = 0;
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      await loginFetch(url, init);
      return Response.json({
        access_token: new URLSearchParams(String(init?.body)).get("code"),
        token_type: "Bearer",
        expires_in: 3600,
        scope:
          "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
      });
    }
    assert.equal(String(url), "https://openidconnect.googleapis.com/v1/userinfo");
    const code = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
    arrivals++;
    if (arrivals === 2) release();
    await ready;
    return Response.json({
      sub: "pinned-subject",
      email: "owner@example.com",
      email_verified: true,
      name: code,
    });
  };
  const outcomes = await Promise.allSettled(raceAttempts.map(callback));
  globalThis.fetch = loginFetch;
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason.code === "TOKEN_RACE");
  const winner = raceAttempts[outcomes.findIndex((result) => result.status === "fulfilled")];
  const winnerCode = new URL(winner.callback).searchParams.get("code");
  assert.equal(await accessToken(env), winnerCode, "Only the winner's connection is stored");
  assert.equal(
    (await db.prepare("SELECT version FROM google_connection").first<{ version: number }>())?.version,
    (beforeVersion?.version ?? 0) + 1,
    "Only one callback may change the connection version"
  );
  assert.equal(
    (await db.prepare("SELECT name FROM owner").first<{ name: string }>())?.name,
    winnerCode,
    "The rejected callback must not overwrite the winning owner's profile"
  );
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM owner_session").first<{ n: number }>())?.n,
    (beforeRace?.n ?? 0) + 1,
    "A rejected independent callback must not persist an owner session"
  );
  for (const data of raceAttempts) await assert.rejects(callback(data), /consumed/);
  const sharedAttempt = await attempt();
  const beforeShared = requests;
  const sharedOutcomes = await Promise.allSettled([callback(sharedAttempt), callback(sharedAttempt)]);
  assert.equal(sharedOutcomes.filter((result) => result.status === "fulfilled").length, 1);
  const sharedRejected = sharedOutcomes.find((result) => result.status === "rejected");
  assert.ok(sharedRejected?.status === "rejected" && sharedRejected.reason.code === "OAUTH_STATE");
  assert.equal(requests, beforeShared + 2, "Concurrent replay must exchange one code and read one identity");
  console.log(
    "PASS independent OAuth callback race persists exactly one session and consumes both states (real local D1)"
  );
  async function expire() {
    await db
      .prepare("UPDATE google_connection SET ciphertext = ?, version = version + 1")
      .bind(
        await seal(
          refreshKey,
          JSON.stringify({ access: "expired", refresh: "refresh-secret", expiresAt: 0 }),
          "google:owner"
        )
      )
      .run();
  }
  await expire();
  tokenReply = { access_token: "refreshed", token_type: "Bearer", expires_in: 120 };
  assert.equal(await accessToken(env), "refreshed");
  const refreshed = await db
    .prepare("SELECT ciphertext FROM google_connection")
    .first<{ ciphertext: string }>();
  assert.ok(refreshed);
  const stored = JSON.parse(await unseal(refreshKey, refreshed.ciphertext, "google:owner"));
  assert.equal(
    stored.refresh,
    "refresh-secret",
    "Refresh responses that omit refresh_token must preserve it"
  );
  assert.ok(stored.expiresAt > Date.now() + 110_000 && stored.expiresAt <= Date.now() + 120_000);
  await expire();
  tokenReply = { access_token: "invalid", token_type: "Bearer", expires_in: "3600" };
  await assert.rejects(accessToken(env), /expiry/);
  const raceFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await db
      .prepare("UPDATE google_connection SET ciphertext = ?, version = version + 1")
      .bind(
        await seal(
          refreshKey,
          JSON.stringify({
            access: "winning-access",
            refresh: "winning-refresh",
            expiresAt: Date.now() + 3600_000,
          }),
          "google:owner"
        )
      )
      .run();
    return Response.json({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });
  };
  assert.equal(
    await accessToken(env),
    "winning-access",
    "A refresh must not overwrite a newer connection version"
  );
  await expire();
  globalThis.fetch = async () => {
    await db
      .prepare("UPDATE google_connection SET ciphertext = ?, version = version + 1")
      .bind(
        await seal(
          refreshKey,
          JSON.stringify({
            access: "winner-after-error",
            refresh: "new-refresh",
            expiresAt: Date.now() + 3600_000,
          }),
          "google:owner"
        )
      )
      .run();
    throw new TypeError("stale request failed");
  };
  assert.equal(await accessToken(env), "winner-after-error");
  await expire();
  const beforeExhaustion = await db
    .prepare("SELECT ciphertext, version FROM google_connection")
    .first<{ ciphertext: string; version: number }>();
  assert.ok(beforeExhaustion);
  let refreshAttempts = 0;
  globalThis.fetch = async () => {
    assert.ok(++refreshAttempts <= 3, "Refresh contention must stop after three attempts");
    await db.prepare("UPDATE google_connection SET version = version + 1").run();
    return Response.json({ access_token: "losing-access", token_type: "Bearer", expires_in: 3600 });
  };
  await assert.rejects(accessToken(env), { code: "TOKEN_RACE" });
  assert.equal(refreshAttempts, 3);
  assert.deepEqual(
    await db.prepare("SELECT ciphertext, version FROM google_connection").first(),
    { ciphertext: beforeExhaustion.ciphertext, version: beforeExhaustion.version + 3 },
    "Exhausted refreshes must leave the winning credential untouched"
  );
  globalThis.fetch = raceFetch;
  await assert.rejects(logout(env, request), /same-origin POST/);
  await logout(
    env,
    new Request(env.PUBLIC_ORIGIN, {
      method: "POST",
      headers: { Cookie: sessionCookie.split(";")[0], Origin: env.PUBLIC_ORIGIN },
    })
  );
  assert.equal(await requireOwner(env, request), null);
  const secondRequest = new Request(env.PUBLIC_ORIGIN, { headers: { Cookie: secondSession } });
  assert.ok(await requireOwner(env, secondRequest));
  await db.prepare("UPDATE owner_session SET expires_at = 0").run();
  assert.equal(
    await requireOwner(env, secondRequest),
    null,
    "An expired, previously valid session must fail closed"
  );
  console.log(
    "PASS OAuth binding, expiry, replay, verified owner, subject pinning, encrypted tokens, fixed sessions, logout (local D1; mocked Google only)"
  );
} finally {
  globalThis.fetch = realFetch;
  await platform.dispose();
}
