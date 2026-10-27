import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Response } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function exchangeTokens(request, codes, refresh, origin, access) {
  assert.equal(request.method, "POST");
  const form = new URLSearchParams(await request.text());
  if (form.get("grant_type") === "authorization_code") {
    const challenge = codes.get(form.get("code"));
    assert.ok(challenge, "only fixture-issued authorization codes are accepted");
    assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), challenge);
    assert.equal(form.get("redirect_uri"), `${origin}/api/auth/callback`);
    codes.delete(form.get("code"));
  } else {
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.ok(form.get("refresh_token") === refresh, "valid fixture refresh token required");
  }
  return json({
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: 3600,
    scope:
      "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
  });
}

export function createGoogleFixture(origin) {
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  const codes = new Map();
  const events = new Map();
  const writes = [];
  const denied = [];
  let revision = 0;
  let cutAfter;
  const cut = (action) => {
    if (cutAfter !== action) return false;
    cutAfter = undefined;
    return true;
  };
  return {
    events,
    writes,
    denied,
    secrets: [access, refresh],
    authorize(url) {
      assert.equal(url.origin, "https://accounts.google.com");
      assert.equal(url.searchParams.get("redirect_uri"), `${origin}/api/auth/callback`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const code = randomBytes(32).toString("base64url");
      codes.set(code, url.searchParams.get("code_challenge"));
      return code;
    },
    loseResponseAfter(action) {
      cutAfter = action;
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
        return exchangeTokens(request, codes, refresh, origin, access);
      }
      if (url.origin === "https://openidconnect.googleapis.com" && url.pathname === "/v1/userinfo") {
        assert.ok(
          request.headers.get("Authorization") === `Bearer ${access}`,
          "valid fixture access token required"
        );
        return json({
          sub: "fixture-owner",
          email: "organizer@example.test",
          email_verified: true,
          name: "Organizer",
        });
      }
      const root = "/calendar/v3/calendars/primary/events";
      if (
        url.origin !== "https://www.googleapis.com" ||
        !(url.pathname === root || url.pathname.startsWith(`${root}/`))
      ) {
        denied.push(url.origin);
        return json({ error: "fixture_outbound_denied" }, 502);
      }
      assert.ok(
        request.headers.get("Authorization") === `Bearer ${access}`,
        "valid fixture access token required"
      );
      const id = decodeURIComponent(url.pathname.slice(root.length + 1));
      const previous = events.get(id);
      if (request.method === "GET") {
        if (id) {
          if (previous) return json(previous);
          return json({ error: { code: 404 } }, 404);
        }
        return json({
          timeZone: "UTC",
          items: [...events.values()].filter(
            (event) =>
              (!url.searchParams.has("timeMin") ||
                Date.parse(event.end.dateTime) > Date.parse(url.searchParams.get("timeMin"))) &&
              (!url.searchParams.has("timeMax") ||
                Date.parse(event.start.dateTime) < Date.parse(url.searchParams.get("timeMax")))
          ),
        });
      }
      assert.equal(url.searchParams.get("sendUpdates"), "all");
      if (request.method === "POST" && !id) {
        const input = await request.json();
        assert.match(input.id, /^[0-9a-v]{5,1024}$/);
        if (events.has(input.id)) return json({ error: { code: 409 } }, 409);
        const event = { ...input, etag: `"fixture-${++revision}"` };
        events.set(input.id, event);
        writes.push({ action: "insert", id: input.id });
        if (cut("insert")) return new Response("truncated", { status: 200 });
        return json(event);
      }
      if (!previous) return json({ error: { code: 404 } }, 404);
      if (request.headers.get("If-Match") !== previous.etag) return json({ error: { code: 412 } }, 412);
      if (request.method === "PATCH") {
        const event = { ...previous, ...(await request.json()), id, etag: `"fixture-${++revision}"` };
        events.set(id, event);
        writes.push({ action: "update", id });
        if (cut("update")) return new Response("truncated", { status: 200 });
        return json(event);
      }
      assert.equal(request.method, "DELETE");
      events.delete(id);
      writes.push({ action: "delete", id });
      if (cut("delete")) return json({ error: "response_lost_after_apply" }, 503);
      return new Response(null, { status: 204 });
    },
  };
}
