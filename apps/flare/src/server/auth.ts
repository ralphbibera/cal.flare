import {
  ErrorWithCode,
  encryptionKey,
  hash,
  nonempty,
  object,
  randomSecret,
  seal,
  unseal,
} from "./secrets.ts";

export interface AuthEnv {
  DB: D1Database;
  PUBLIC_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_OWNER_EMAIL: string;
  TOKEN_ENCRYPTION_KEY: string;
}
type Tokens = { access: string; refresh: string; expiresAt: number };
const sessionSeconds = 7 * 24 * 60 * 60;
const tokenEndpoint = "https://oauth2.googleapis.com/token";
export const GOOGLE_SCOPES =
  "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly";

async function config(env: AuthEnv, request?: Request) {
  let origin: URL;
  try {
    origin = new URL(env.PUBLIC_ORIGIN);
  } catch {
    throw new ErrorWithCode("CONFIGURATION", "Invalid PUBLIC_ORIGIN");
  }
  if (
    origin.origin !== env.PUBLIC_ORIGIN ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    ) ||
    !env.GOOGLE_CLIENT_ID?.trim() ||
    !env.GOOGLE_CLIENT_SECRET?.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.GOOGLE_OWNER_EMAIL ?? "")
  ) {
    throw new ErrorWithCode("CONFIGURATION", "Invalid organizer OAuth configuration");
  }
  if (request && new URL(request.url).origin !== origin.origin)
    throw new ErrorWithCode("ORIGIN", "Request origin does not match PUBLIC_ORIGIN");
  return {
    origin: origin.origin,
    key: await encryptionKey(env.TOKEN_ENCRYPTION_KEY),
    email: env.GOOGLE_OWNER_EMAIL.toLowerCase(),
  };
}
function cookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function setCookie(name: string, value: string, seconds: number, origin: string): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${origin.startsWith("https:") ? "; Secure" : ""}`;
}
function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
}
export async function beginLogin(env: AuthEnv, request: Request): Promise<Response> {
  const { origin, key } = await config(env, request);
  const state = randomSecret(),
    binding = randomSecret(),
    verifier = randomSecret();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_attempt WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM owner_session WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO oauth_attempt VALUES (?, ?, ?, ?)").bind(
      await hash(state),
      await hash(binding),
      await seal(key, verifier, "oauth-pkce"),
      now + 600_000
    ),
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    state,
    code_challenge: await hash(verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    login_hint: env.GOOGLE_OWNER_EMAIL,
  }).toString();
  return redirect(url.href, [setCookie("flare_oauth", binding, 600, origin)]);
}
async function exchange(env: AuthEnv, parameters: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        ...parameters,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
  } catch {
    throw new ErrorWithCode("TOKEN_NETWORK", "Google token request failed");
  }
  if (!response.ok)
    throw new ErrorWithCode("TOKEN_REJECTED", `Google token request returned ${response.status}`);
  return response.json();
}
function parseTokens(value: unknown, previousRefresh?: string): Tokens {
  const data = object(value);
  if (
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 31_536_000 ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer"
  )
    throw new ErrorWithCode("UPSTREAM_SHAPE", "Invalid Google token expiry or type");
  return {
    access: nonempty(data.access_token),
    refresh: data.refresh_token === undefined ? nonempty(previousRefresh) : nonempty(data.refresh_token),
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
function storedTokens(value: string): Tokens {
  const data = object(JSON.parse(value));
  if (typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt))
    throw new ErrorWithCode("TOKEN_STORAGE", "Invalid stored token expiry");
  return { access: nonempty(data.access), refresh: nonempty(data.refresh), expiresAt: data.expiresAt };
}
export async function finishLogin(env: AuthEnv, request: Request): Promise<Response> {
  const { origin, key, email } = await config(env, request);
  const url = new URL(request.url),
    state = url.searchParams.get("state"),
    binding = cookie(request, "flare_oauth");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !binding)
    throw new ErrorWithCode("OAUTH_STATE", "Missing OAuth browser binding or state");
  const attempt = await env.DB.prepare(
    "DELETE FROM oauth_attempt WHERE state_hash = ? AND binding_hash = ? AND expires_at > ? RETURNING verifier_ciphertext"
  )
    .bind(await hash(state), await hash(binding), Date.now())
    .first<{ verifier_ciphertext: string }>();
  if (!attempt) throw new ErrorWithCode("OAUTH_STATE", "Expired or already consumed OAuth attempt");
  const code = url.searchParams.get("code");
  if (
    !code ||
    url.searchParams.has("error") ||
    url.searchParams.getAll("code").length !== 1 ||
    url.searchParams.getAll("state").length !== 1
  )
    throw new ErrorWithCode("OAUTH_CODE", "Google did not supply an authorization code");
  const tokenData = await exchange(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: await unseal(key, attempt.verifier_ciphertext, "oauth-pkce"),
    redirect_uri: `${origin}/api/auth/callback`,
  });
  const raw = object(tokenData);
  const scopes = new Set(typeof raw.scope === "string" ? raw.scope.split(/\s+/) : []);
  const calendar = "https://www.googleapis.com/auth/calendar";
  if (
    ![
      [calendar, `${calendar}.events`],
      [calendar, `${calendar}.readonly`, `${calendar}.events.freebusy`],
      [calendar, `${calendar}.readonly`, `${calendar}.calendarlist`, `${calendar}.calendarlist.readonly`],
    ].every((permissions) => permissions.some((scope) => scopes.has(scope)))
  )
    throw new ErrorWithCode("FORBIDDEN", "Required Google Calendar permissions were not granted");
  const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${nonempty(raw.access_token)}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (!identityResponse.ok) throw new ErrorWithCode("OAUTH_IDENTITY", "Google identity request failed");
  const identity = object(await identityResponse.json());
  if (
    identity.email_verified !== true ||
    typeof identity.email !== "string" ||
    identity.email.toLowerCase() !== email
  )
    throw new ErrorWithCode("FORBIDDEN", "Only the configured verified Google owner may sign in");
  const sub = nonempty(identity.sub),
    name = typeof identity.name === "string" ? identity.name : email;
  const previous = await env.DB.prepare(
    "SELECT g.ciphertext, g.version FROM google_connection g JOIN owner o ON o.id = g.owner_id WHERE o.id = 'owner' AND o.google_sub = ?"
  )
    .bind(sub)
    .first<{ ciphertext: string; version: number }>();
  const tokens = parseTokens(
    tokenData,
    raw.refresh_token === undefined && previous
      ? storedTokens(await unseal(key, previous.ciphertext, "google:owner")).refresh
      : undefined
  );
  const session = randomSecret();
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO owner (id, google_sub, email, name) VALUES ('owner', ?, ?, ?) ON CONFLICT(id) DO NOTHING"
    ).bind(sub, email, name),
    env.DB.prepare(
      "INSERT INTO google_connection (owner_id, ciphertext, version) SELECT 'owner', ?, 1 FROM owner WHERE id = 'owner' AND google_sub = ? ON CONFLICT(owner_id) DO UPDATE SET ciphertext = excluded.ciphertext, version = google_connection.version + 1 WHERE google_connection.version = ?"
    ).bind(await seal(key, JSON.stringify(tokens), "google:owner"), sub, previous?.version ?? 0),
    // D1 commits zero-row CAS statements. Gate every later write on the preceding write winning.
    env.DB.prepare(
      "UPDATE owner SET email = ?, name = ? WHERE id = 'owner' AND google_sub = ? AND changes() = 1"
    ).bind(email, name, sub),
    env.DB.prepare(
      "INSERT INTO owner_session SELECT ?, 'owner', ? FROM owner WHERE id = 'owner' AND google_sub = ? AND changes() = 1"
    ).bind(await hash(session), Date.now() + sessionSeconds * 1000, sub),
  ]);
  if (results[1].meta.changes !== 1) {
    const owner = await env.DB.prepare("SELECT google_sub FROM owner WHERE id = 'owner'").first<{
      google_sub: string;
    }>();
    if (owner?.google_sub !== sub)
      throw new ErrorWithCode("FORBIDDEN", "Google subject does not match the pinned owner");
    throw new ErrorWithCode("TOKEN_RACE", "Google connection changed during login; sign in again");
  }
  return redirect(`${origin}/`, [
    setCookie("flare_session", session, sessionSeconds, origin),
    setCookie("flare_oauth", "", 0, origin),
  ]);
}
export async function requireOwner(
  env: AuthEnv,
  request: Request
): Promise<{ id: string; email: string; name: string } | null> {
  const { email } = await config(env, request);
  const token = cookie(request, "flare_session");
  if (!token) return null;
  return env.DB.prepare(
    "SELECT o.id, o.email, o.name FROM owner_session s JOIN owner o ON o.id = s.owner_id WHERE s.token_hash = ? AND s.expires_at > ? AND o.email = ?"
  )
    .bind(await hash(token), Date.now(), email)
    .first<{ id: string; email: string; name: string }>();
}
export async function logout(env: AuthEnv, request: Request): Promise<Response> {
  const { origin } = await config(env, request);
  if (request.method !== "POST" || request.headers.get("Origin") !== origin)
    throw new ErrorWithCode("ORIGIN", "Logout requires a same-origin POST");
  const token = cookie(request, "flare_session");
  if (token)
    await env.DB.prepare("DELETE FROM owner_session WHERE token_hash = ?")
      .bind(await hash(token))
      .run();
  return redirect(`${origin}/`, [setCookie("flare_session", "", 0, origin)]);
}
export async function accessToken(env: AuthEnv): Promise<string> {
  const { key, email } = await config(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const connection = await env.DB.prepare(
      "SELECT g.ciphertext, g.version FROM google_connection g JOIN owner o ON o.id = g.owner_id WHERE o.id = 'owner' AND o.email = ?"
    )
      .bind(email)
      .first<{ ciphertext: string; version: number }>();
    if (!connection) throw new ErrorWithCode("GOOGLE_DISCONNECTED", "Organizer must connect Google Calendar");
    const tokens = storedTokens(await unseal(key, connection.ciphertext, "google:owner"));
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.access;
    let refreshed: Tokens;
    try {
      refreshed = parseTokens(
        await exchange(env, { grant_type: "refresh_token", refresh_token: tokens.refresh }),
        tokens.refresh
      );
    } catch (error) {
      const latest = await env.DB.prepare(
        "SELECT version FROM google_connection WHERE owner_id = 'owner'"
      ).first<{ version: number }>();
      if (latest && latest.version !== connection.version) continue;
      throw error;
    }
    const result = await env.DB.prepare(
      "UPDATE google_connection SET ciphertext = ?, version = version + 1 WHERE owner_id = 'owner' AND version = ?"
    )
      .bind(await seal(key, JSON.stringify(refreshed), "google:owner"), connection.version)
      .run();
    if (result.meta.changes === 1) return refreshed.access;
  }
  throw new ErrorWithCode("TOKEN_RACE", "Google connection changed during token refresh");
}
