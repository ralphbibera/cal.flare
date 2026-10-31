import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Response } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function eventTarget(url) {
  if (url.origin !== "https://www.googleapis.com") return null;
  const target = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(.*))?$/.exec(url.pathname);
  return target
    ? { calendarId: decodeURIComponent(target[1]), id: decodeURIComponent(target[2] ?? "") }
    : null;
}

async function exchangeTokens(request, codes, refresh, origin, access, grants) {
  assert.equal(request.method, "POST");
  const form = new URLSearchParams(await request.text());
  grants.push(form.get("grant_type"));
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
      "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  });
}

export function createGoogleFixture(origin) {
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  const codes = new Map();
  const events = new Map();
  const calendarEvents = new Map([["primary", events]]);
  const calendars = [];
  const calendarReads = [];
  const busyReads = [];
  const secondaryBusy = new Map();
  const busyFailures = new Map();
  const writes = [];
  const denied = [];
  const grants = [];
  let revision = 0;
  let cutAfter;
  const eventsFor = (id) => {
    if (!calendarEvents.has(id)) calendarEvents.set(id, new Map());
    return calendarEvents.get(id);
  };
  const accessRole = (id) =>
    id === "primary" ? "owner" : calendars.find((entry) => entry.id === id && !entry.deleted)?.accessRole;
  const cut = (action) => {
    if (cutAfter !== action) return false;
    cutAfter = undefined;
    return true;
  };

  function listCalendars(request, url) {
    assert.ok(
      request.headers.get("Authorization") === `Bearer ${access}`,
      "valid fixture access token required"
    );
    assert.equal(request.method, "GET");
    assert.equal(url.searchParams.get("maxResults"), "250");
    assert.equal(url.searchParams.get("showHidden"), "true");
    assert.equal(url.searchParams.get("showDeleted"), "false");
    calendarReads.push(url.search);
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    return json({
      items: calendars.slice(offset, offset + 250),
      ...(offset + 250 < calendars.length ? { nextPageToken: String(offset + 250) } : {}),
    });
  }

  async function freeBusy(request) {
    assert.equal(request.headers.get("Authorization"), `Bearer ${access}`);
    assert.equal(request.method, "POST");
    const input = await request.json();
    assert.equal(input.calendarExpansionMax, 50);
    assert.ok(input.items.length <= 50);
    const ids = input.items.map(({ id }) => id);
    busyReads.push(ids);
    const failure = ids.map((id) => busyFailures.get(id)).find((value) => value !== undefined);
    if (typeof failure === "number" || failure?.after === busyReads.length)
      return json(
        { error: "Private calendar failure" },
        typeof failure === "number" ? failure : failure.status
      );
    const calendars = Object.fromEntries(
      ids
        .filter((id) => busyFailures.get(id) !== "missing")
        .map((id) => [
          id,
          busyFailures.has(id) && !busyFailures.get(id)?.after
            ? busyFailures.get(id)
            : { busy: secondaryBusy.get(id) ?? [] },
        ])
    );
    return json({ calendars });
  }

  function readEvents(calendarId, id, previous, url) {
    if (id) {
      if (previous) return json(previous);
      return json({ error: { code: 404 } }, 404);
    }
    return json({
      timeZone: "UTC",
      accessRole: accessRole(calendarId),
      items: [...eventsFor(calendarId).values()].filter(
        (event) =>
          (!url.searchParams.has("timeMin") ||
            Date.parse(event.end.dateTime) > Date.parse(url.searchParams.get("timeMin"))) &&
          (!url.searchParams.has("timeMax") ||
            Date.parse(event.start.dateTime) < Date.parse(url.searchParams.get("timeMax")))
      ),
    });
  }

  async function insertEvent(request, calendarId) {
    const events = eventsFor(calendarId);
    const input = await request.json();
    assert.match(input.id, /^[0-9a-v]{5,1024}$/);
    if (events.has(input.id)) return json({ error: { code: 409 } }, 409);
    const event = {
      ...input,
      etag: `"fixture-${++revision}"`,
      organizer: { email: calendarId === "primary" ? "organizer@example.test" : calendarId, self: true },
    };
    events.set(input.id, event);
    writes.push({ action: "insert", id: input.id, calendarId });
    if (cut("insert")) return new Response("truncated", { status: 200 });
    return json(event);
  }

  async function updateEvent(request, id, previous, calendarId) {
    const event = { ...previous, ...(await request.json()), id, etag: `"fixture-${++revision}"` };
    eventsFor(calendarId).set(id, event);
    writes.push({ action: "update", id, calendarId });
    if (cut("update")) return new Response("truncated", { status: 200 });
    return json(event);
  }

  async function eventRequest(request, url, { calendarId, id }) {
    const role = accessRole(calendarId);
    if (!role || role === "none") return json({ error: "calendar_access_denied" }, 403);
    const previous = eventsFor(calendarId).get(id);
    if (request.method === "GET") return readEvents(calendarId, id, previous, url);
    return writeEvent(request, url, { calendarId, id, previous, role });
  }

  async function writeEvent(request, url, { calendarId, id, previous, role }) {
    if (role !== "owner" && role !== "writer") return json({ error: "calendar_write_denied" }, 403);
    assert.equal(url.searchParams.get("sendUpdates"), "all");
    if (request.method === "POST" && !id) return insertEvent(request, calendarId);
    if (!previous) return json({ error: { code: 404 } }, 404);
    if (request.headers.get("If-Match") !== previous.etag) return json({ error: { code: 412 } }, 412);
    if (request.method === "PATCH") return updateEvent(request, id, previous, calendarId);
    assert.equal(request.method, "DELETE");
    eventsFor(calendarId).delete(id);
    writes.push({ action: "delete", id, calendarId });
    if (cut("delete")) return json({ error: "response_lost_after_apply" }, 503);
    return new Response(null, { status: 204 });
  }

  return {
    events,
    calendarEvents,
    calendars,
    calendarReads,
    busyReads,
    secondaryBusy,
    busyFailures,
    writes,
    denied,
    grants,
    secrets: [access, refresh],
    authorize(url) {
      assert.equal(url.origin, "https://accounts.google.com");
      assert.equal(url.searchParams.get("redirect_uri"), `${origin}/api/auth/callback`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("include_granted_scopes"), "true");
      assert.equal(
        url.searchParams.get("scope"),
        "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly"
      );
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
        return exchangeTokens(request, codes, refresh, origin, access, grants);
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
      if (
        url.origin === "https://www.googleapis.com" &&
        url.pathname === "/calendar/v3/users/me/calendarList"
      ) {
        return listCalendars(request, url);
      }
      if (url.origin === "https://www.googleapis.com" && url.pathname === "/calendar/v3/freeBusy") {
        return freeBusy(request);
      }
      const target = eventTarget(url);
      if (!target) {
        denied.push(url.origin);
        return json({ error: "fixture_outbound_denied" }, 502);
      }
      assert.ok(
        request.headers.get("Authorization") === `Bearer ${access}`,
        "valid fixture access token required"
      );
      return eventRequest(request, url, target);
    },
  };
}
