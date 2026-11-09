import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WEBAPP_URL, WEBAPP_URL_FOR_OAUTH } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { PartialReference } from "@calcom/types/EventManager";
import type { VideoApiAdapter } from "@calcom/types/VideoApiAdapter";
import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { prisma, sendgridRequest, dubTrackLead, dubTokens, vital } = vi.hoisted(() => ({
  prisma: {
    credential: { create: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    user: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    app: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    eventType: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
  },
  sendgridRequest: vi.fn(),
  dubTrackLead: vi.fn(),
  dubTokens: [] as string[],
  vital: { userCreate: vi.fn(), userResolve: vi.fn(), linkCreate: vi.fn(), constructEvent: vi.fn() },
}));
vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/lib/logger", () => {
  const make = () => Object.assign({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), silly: vi.fn(), warn: vi.fn() }, { getSubLogger: make });
  return { default: make() };
});
vi.mock("@sendgrid/client", () => ({ default: { request: sendgridRequest, setApiKey: vi.fn() } }));
vi.mock("dub-package", () => ({
  Dub: class { track = { lead: dubTrackLead }; constructor({ token }: { token: string }) { dubTokens.push(token); } },
}));
vi.mock("@tryvital/vital-node", () => ({
  VitalClient: class {
    User = { create: vital.userCreate, resolve: vital.userResolve };
    Link = { create: vital.linkCreate };
    Webhooks = { constructWebhookEvent: vital.constructEvent };
  },
}));
import { appStoreMetadata } from "../appStoreMetaData";
import { appDataSchemas } from "../apps.schemas.generated";
import { REDIRECT_APPS } from "../redirect-apps.generated";
import { VideoApiAdapterMap } from "../video.adapters.generated";

const appApis = import.meta.glob<{ add?: unknown }>("../*/api/index.ts");

const APP_STORE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const rows = readFileSync(join(REPO_ROOT, "docs/porting/inventory/integrations.tsv"), "utf8")
  .trimEnd()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.split("\t")[0]);
const USER_ID = 7;
const EVENT = { title: "Planning Session", type: "30min", startTime: "2024-01-15T09:00:00.000Z", endTime: "2024-01-15T10:00:00.000Z", description: "Agenda", uid: "booking-uid", location: "Office", attendees: [{ email: "alex@example.com", name: "Alex" }], organizer: { email: "jane@example.com", name: "Jane" }, team: { name: "Team" } } as unknown as CalendarEvent;
const REF = { type: "video", uid: "booking-uid", meetingId: "meeting-1", meetingPassword: "pass", meetingUrl: "https://meeting.example/1", externalCalendarId: "external-1" } as unknown as PartialReference;
const INSTALL_SLUGS = new Set(`attio campfire databuddy demodesk dialpad discord eightxeight element-call facetime famulor fathom ga4 gtm horizon-workrooms insihts linear make matomo metapixel mirotalk plausible posthog qr_code roam salesroom shimmervideo signal sirius_video skype telegram twipla umami weather_in_your_calendar whatsapp zapier wipemycalother jitsivideo sylapsvideo ping riverside whereby`.split(" "));
const ANALYTICS_SLUGS = new Set(`databuddy fathom ga4 gtm insihts matomo metapixel plausible posthog twipla umami`.split(" "));
const REMAINING_SLUGS = new Set(`alby applecalendar btcpayserver caldavcalendar closecom dailyvideo exchange2013calendar exchange2016calendar exchangecalendar feishucalendar googlecalendar googlevideo hitpay hubspot ics-feedcalendar larkcalendar mock-payment-app nextcloudtalk office365calendar office365video paypal pipedrive-crm salesforce stripepayment webex zoho-bigin zohocalendar zohocrm zoomvideo`.split(" "));
const CATALOG_SLUGS = new Set(rows.filter((slug) => !existsSync(join(APP_STORE_DIR, slug, "package.json")) && !existsSync(join(APP_STORE_DIR, slug, "index.ts"))));
const FUNCTION_INSTALLS: Record<string, { appId: string; appType: string; url: string }> = {
  ping: { appId: "ping", appType: "ping_video", url: "/apps/installed/conferencing?hl=ping" },
  riverside: { appId: "riverside", appType: "riverside_video", url: "/apps/installed/conferencing?hl=riverside" },
  whereby: { appId: "whereby", appType: "whereby_video", url: "/apps/installed/conferencing?hl=whereby" },
  wipemycalother: { appId: "wipe-my-cal", appType: "wipemycal_other", url: "/apps/installed/other?hl=wipe-my-cal" },
  jitsivideo: { appId: "jitsi", appType: "jitsi_video", url: "/apps/installed/conferencing?hl=jitsi" },
  sylapsvideo: { appId: "sylapsvideo", appType: "sylaps_video", url: "/apps/installed/conferencing?hl=sylapsvideo" },
};
const REDIRECTS: Record<string, { newTab: boolean; url: string }> = {
  attio: { newTab: false, url: "/apps/installed/crm" },
  famulor: { newTab: true, url: "https://docs.famulor.io/en/ai-assistants/cal-com-scheduling" },
  linear: { newTab: true, url: "https://linear.app/settings/integrations/google-calendar" },
  make: { newTab: true, url: "/apps/make/setup" },
  zapier: { newTab: true, url: "https://zapier.com/apps/calcom/integrations" },
};
const TAG_VALUES: Record<string, string> = { API_HOST: "https://posthog.example", CLIENT_ID: "client-1", DATABUDDY_API_URL: "https://basket.example", DATABUDDY_SCRIPT_URL: "https://cdn.example/databuddy.js", MATOMO_URL: "https://matomo.example", PLAUSIBLE_URL: "https://plausible.example/js/script.js", SCRIPT_URL: "https://cdn.example/script.js", SITE_ID: "site-1", TRACKING_EVENT: "Lead", TRACKING_ID: "cal-test" };

type MockResponse = { [K in "end" | "json" | "redirect" | "send" | "setHeader" | "status"]: ReturnType<typeof vi.fn> } & { writableEnded: boolean };
const createResponse = (): MockResponse => {
  const res = { end: vi.fn(), json: vi.fn(), redirect: vi.fn(), send: vi.fn(), setHeader: vi.fn(), status: vi.fn(), writableEnded: false } as MockResponse;
  for (const method of [res.end, res.json, res.redirect, res.send, res.setHeader, res.status]) method.mockReturnValue(res);
  return res;
};
const createRequest = (overrides: Record<string, unknown> = {}) =>
  ({ method: "GET", query: {}, body: {}, headers: {}, url: "/api/integrations/test", session: { user: { id: USER_ID, username: "jane", email: "jane@example.com" } }, ...overrides }) as unknown as NextApiRequest;
const invoke = async (handler: NextApiHandler, req = createRequest(), res = createResponse()) => {
  await handler(req, res as unknown as NextApiResponse);
  return res;
};
const bodyOf = (res: MockResponse) => res.json.mock.calls[0]?.[0] ?? res.send.mock.calls[0]?.[0];
const jsonResponse = (body: unknown, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), { status, statusText, headers: { "Content-Type": "application/json" } });
const loadAdd = async (slug: string) => (await appApis[`../${slug}/api/index.ts`]()).add;
const metadataOf = (slug: string) => appStoreMetadata[slug as keyof typeof appStoreMetadata];
const fetchCall = (fetchMock: ReturnType<typeof vi.fn>, index = 0) => fetchMock.mock.calls[index] as [string, RequestInit];
const expectFetch = (fetchMock: ReturnType<typeof vi.fn>, index: number, url: string, init: RequestInit) => {
  const [actualUrl, actualInit] = fetchCall(fetchMock, index);
  expect(actualUrl).toBe(url);
  expect(actualInit).toMatchObject(init);
};
const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

const verifyInstall = async (slug: string) => {
  const metadata = metadataOf(slug);
  const functionInstall = FUNCTION_INSTALLS[slug];
  if (functionInstall) {
    const res = await invoke((await loadAdd(slug)) as NextApiHandler);
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: functionInstall.appType, key: {}, userId: USER_ID, appId: functionInstall.appId },
    });
    expect(bodyOf(res)).toEqual({ url: functionInstall.url });
  } else {
    const add = (await loadAdd(slug)) as {
      appType: string;
      redirect?: { newTab?: boolean; url: string };
      slug: string;
      supportsMultipleInstalls: boolean;
      variant: string;
      handlerType: string;
      createCredential: (args: { appType: string; slug: string; user: { id: number } }) => Promise<unknown>;
    };
    expect(add).toMatchObject({
      appType: metadata.type,
      slug: metadata.slug,
      variant: metadata.variant,
      handlerType: "add",
      supportsMultipleInstalls: false,
    });
    await add.createCredential({ appType: add.appType, slug: add.slug, user: { id: USER_ID } });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: metadata.type, key: {}, userId: USER_ID, appId: metadata.slug },
    });
    expect({ url: add.redirect?.url, newTab: add.redirect?.newTab }).toEqual(REDIRECTS[slug] ?? { url: undefined, newTab: undefined });
  }
  const location = metadata.appData?.location;
  if (location) expect(["static", "dynamic"]).toContain(location.linkType);
};

const verifyCatalog = (slug: string) => {
  const externalLink = (metadataOf(slug) as unknown as { externalLink?: { url: string } }).externalLink;
  expect(externalLink?.url.length).toBeGreaterThan(0);
  expect(REDIRECT_APPS).toContain(slug);
  expect(appApis[`../${slug}/api/index.ts`]).toBeUndefined();
};

const verifyAnalytics = (slug: string) => {
  const metadata = metadataOf(slug);
  const tag = metadata.appData?.tag;
  expect(metadata.variant).toBe("analytics");
  expect(tag?.scripts?.length).toBeGreaterThan(0);
  const schema = appDataSchemas[slug as keyof typeof appDataSchemas] as unknown as { parse: (value: unknown) => Record<string, unknown>; shape: Record<string, unknown> };
  const placeholders = Array.from(new Set(Array.from(JSON.stringify(tag).matchAll(/\{([A-Z0-9_]+)\}/g), (match) => match[1])));
  expect(placeholders.length).toBeGreaterThan(0);
  const sample = Object.fromEntries(placeholders.map((placeholder) => {
    const camelKey = placeholder.toLowerCase().replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
    const key = placeholder in schema.shape ? placeholder : camelKey;
    expect(schema.shape[key], `${slug} has no appData key for {${placeholder}}`).toBeDefined();
    return [key, TAG_VALUES[placeholder]];
  }));
  const parsed = schema.parse(sample);
  const values: Record<string, unknown> = { ...parsed, TRACKING_ID: parsed.TRACKING_ID ?? parsed.trackingId ?? null, TRACKING_EVENT: parsed.trackingEvent ?? "Lead" };
  const render = (value: string) => value.replace(/\{([A-Z0-9_]+)\}/g, (_match, name: string) => String(values[name]));
  for (const script of tag?.scripts ?? []) {
    const rendered = render(JSON.stringify(script));
    expect(rendered).not.toMatch(/\{[A-Z0-9_]+\}/);
    for (const match of Array.from(JSON.stringify(script).matchAll(/\{([A-Z0-9_]+)\}/g))) expect(rendered).toContain(String(values[match[1]]));
  }
  expect(schema.parse(parsed)).toEqual(parsed);
};

const meeting = (type: string, id: string, url: string, password = "") => ({ type, id, password, url });
type VideoCall = [method: string | null, path: string, body: unknown, response: unknown, expected: unknown, headers?: Record<string, string>, sync?: { path: string; body: unknown }];
const dailyRoom = {
  id: "room-id", name: "room-name", api_created: true, privacy: "private", url: "https://cal.daily.co/room-name", created_at: "2024-01-01T00:00:00.000Z",
  config: { enable_prejoin_ui: true, enable_people_ui: true, enable_emoji_reactions: true, enable_pip_ui: true, enable_hand_raising: true, enable_network_ui: true, enable_video_processing_ui: true, enable_noise_cancellation_ui: true, enable_advanced_chat: true, enable_chat: true, enable_knocking: true },
};
const VIDEOS: Record<string, { credential: CredentialPayload; base: string; calls: VideoCall[]; failure?: [number, string, Response?] }> = {
  huddle01video: {
    credential: { id: 1, key: { identityToken: "huddle-identity" }, userId: 1 } as unknown as CredentialPayload,
    base: "https://platform-api.huddle01.workers.dev/api/v2/calendar/",
    calls: [
      ["POST", "createMeeting", { title: EVENT.title, startTime: EVENT.startTime, endTime: EVENT.endTime }, { roomId: "room-1", meetingLink: "https://huddle.example/room-1" }, meeting("huddle01_video", "room-1", "https://huddle.example/room-1"), { "Content-Type": "application/json", "x-api-key": "huddle-api-key", "x-identity-token": "huddle-identity" }],
      ["PUT", "updateMeeting", { title: EVENT.title, startTime: EVENT.startTime, endTime: EVENT.endTime, meetingId: "booking-uid" }, { roomId: "room-2", meetingLink: "https://huddle.example/room-2" }, meeting("huddle01_video", "room-2", "https://huddle.example/room-2")],
      ["DELETE", "deleteMeeting", { meetingId: "meeting-1" }, { roomId: "room-3", meetingLink: "https://huddle.example/room-3" }, meeting("huddle01_video", "room-3", "https://huddle.example/room-3")],
    ],
    failure: [0, "Error while creating meeting"],
  },
  jelly: {
    credential: { id: 1, key: { access_token: "jelly-token" }, userId: 1 } as unknown as CredentialPayload,
    base: "https://www.jellyjelly.com/api/ti/",
    calls: [
      ["POST", "start_jelly", undefined, { talkId: "talk-1", url: "https://jelly.example/talk-1" }, meeting("jelly_conferencing", "talk-1", "https://jelly.example/talk-1"), { Authorization: "Bearer jelly-token", "Content-Type": "application/json" }],
      [null, "", undefined, undefined, meeting("jelly_conferencing", "external-1", "https://meeting.example/1")],
      [null, "", undefined, undefined, {}],
    ],
    failure: [0, "socket hang up"],
  },
  jitsivideo: {
    credential: { id: 1, key: {}, userId: 1 } as unknown as CredentialPayload,
    base: "",
    calls: [
      [null, "", undefined, undefined, (value: unknown) => {
        const result = value as { id: string; url: string; type: string };
        expect(result.type).toBe("jitsi_video");
        expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.url).toBe(`https://meet.jit.si/cal/${encodeURIComponent(result.id)}`);
      }],
      [null, "", undefined, undefined, meeting("jitsi_video", "meeting-1", "https://meeting.example/1", "pass")],
      [null, "", undefined, undefined, undefined],
    ],
  },
  lyra: {
    credential: { id: 1, key: { access_token: "lyra-token", refresh_token: "lyra-refresh", token_type: "Bearer", expiry_date: Date.now() + 3_600_000 }, userId: 1 } as unknown as CredentialPayload,
    base: "https://app.lyra.so/api/v1/",
    calls: [
      ["POST", "meeting", { title: EVENT.title, start: EVENT.startTime, attendees: ["alex@example.com"] }, { id: "lyra-1", url: "https://lyra.example/1" }, meeting("lyra_video", "lyra-1", "https://lyra.example/1"), { "Content-Type": "application/json" }],
      [null, "", undefined, undefined, meeting("lyra_video", "meeting-1", "https://meeting.example/1", "pass")],
      [null, "", undefined, undefined, undefined],
    ],
    failure: [0, "Failed to create Lyra meeting"],
  },
  shimmervideo: {
    credential: { id: 1, key: {}, userId: 1 } as unknown as CredentialPayload,
    base: "https://api.daily.co/v1/",
    calls: [
      ["POST", "rooms", { privacy: "private", properties: { enable_prejoin_ui: true, enable_people_ui: true, enable_emoji_reactions: true, enable_pip_ui: true, enable_hand_raising: true, enable_network_ui: true, enable_video_processing_ui: true, enable_noise_cancellation_ui: true, enable_advanced_chat: true, enable_knocking: true, enable_screenshare: true, enable_chat: true } }, dailyRoom, meeting("shimmer_video", "room-name", "https://app.shimmer.care?videoId=room-name"), { Authorization: "Bearer shimmer-key", "Content-Type": "application/json" }, { path: "https://shimmer.example/api/trackDailyRoom", body: { cal: EVENT, daily: dailyRoom } }],
      ["POST", "rooms/booking-uid", undefined, dailyRoom, meeting("shimmer_video", "room-name", "https://app.shimmer.care?videoId=room-name"), undefined, { path: "https://shimmer.example/api/trackDailyRoom", body: { cal: EVENT, daily: dailyRoom } }],
      ["DELETE", "rooms/meeting-1", undefined, {}, undefined, { Authorization: "Bearer shimmer-key", "Content-Type": "application/json" }],
    ],
    failure: [0, "Server Error", jsonResponse({}, 500, "Server Error")],
  },
  sylapsvideo: {
    credential: { id: 1, key: {}, userId: 1 } as unknown as CredentialPayload,
    base: "",
    calls: [
      [null, "", undefined, undefined, (value: unknown) => {
        const result = value as { id: string; url: string; type: string };
        expect(result.type).toBe("sylaps_video");
        expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(result.url).toBe(`https://sylaps.com/r/${result.id}`);
      }],
      [null, "", undefined, undefined, meeting("sylaps_video", "meeting-1", "https://meeting.example/1", "pass")],
      [null, "", undefined, undefined, undefined],
    ],
  },
  tandemvideo: {
    credential: { id: 1, key: { access_token: "tandem-token", expiry_date: Date.now() + 3_600_000, refresh_token: "tandem-refresh", token_type: "Bearer" }, userId: 1 } as unknown as CredentialPayload,
    base: "https://tandem.example/api/v1/",
    calls: [
      ["POST", "meetings", { meeting: { title: EVENT.title, starts_at: Date.parse(EVENT.startTime) / 1000, ends_at: Date.parse(EVENT.endTime) / 1000, description: EVENT.description, conference_solution: "tandem", type: 3 } }, { data: { id: "tandem-1", event_link: "https://tandem.example/1" } }, meeting("tandem_video", "tandem-1", "https://tandem.example/1"), { Authorization: "Bearer tandem-token", "Content-Type": "application/json" }],
      ["PUT", "meetings/meeting-1", { updates: { title: EVENT.title, starts_at: Date.parse(EVENT.startTime) / 1000, ends_at: Date.parse(EVENT.endTime) / 1000, description: EVENT.description, conference_solution: "tandem", type: 3 } }, { data: { id: "tandem-2", event_link: "https://tandem.example/2" } }, meeting("tandem_video", "tandem-2", "https://tandem.example/2"), { Authorization: "Bearer tandem-token", "Content-Type": "application/json" }],
      ["DELETE", "meetings/meeting-1", undefined, {}, undefined, { Authorization: "Bearer tandem-token" }],
    ],
    failure: [0, "socket hang up"],
  },
};
const APP_KEYS: Record<string, Record<string, string>> = {
  jitsivideo: { jitsiHost: "https://meet.jit.si/cal", jitsiPathPattern: "{uuid}" },
  lyra: { client_id: "lyra-client", client_secret: "lyra-secret" },
  shimmervideo: { api_key: "shimmer-key", api_route: "https://shimmer.example/api/" },
  tandemvideo: { base_url: "https://tandem.example", client_id: "tandem-client", client_secret: "tandem-secret" },
};
const runVideo = async (slug: string, fetchMock: ReturnType<typeof vi.fn>) => {
  const spec = VIDEOS[slug];
  prisma.app.findUnique.mockResolvedValue({ keys: APP_KEYS[slug] ?? {} });
  prisma.credential.findFirst.mockResolvedValue({ id: 1, key: spec.credential.key, userId: USER_ID });
  const module = await VideoApiAdapterMap[slug as keyof typeof VideoApiAdapterMap];
  const adapter = (module as { default: (credential: CredentialPayload) => VideoApiAdapter }).default(spec.credential) as NonNullable<VideoApiAdapter>;
  const calls = [() => adapter.createMeeting(EVENT), () => adapter.updateMeeting(REF, EVENT), () => adapter.deleteMeeting("meeting-1")];
  for (let index = 0; index < spec.calls.length; index++) {
    const [method, path, callBody, response, expected, headers, sync] = spec.calls[index];
    fetchMock.mockReset();
    if (method) fetchMock.mockResolvedValueOnce(jsonResponse(response));
    const result = await calls[index]();
    if (method) {
      const [url, init] = fetchCall(fetchMock);
      expect(url).toBe(spec.base + path);
      expect(init.method).toBe(method);
      if (callBody !== undefined) expect(JSON.parse(String(init.body))).toEqual(callBody);
      if (headers) expect(init.headers).toMatchObject(headers);
      if (sync) {
        const [syncUrl, syncInit] = fetchCall(fetchMock, 1);
        expect(syncUrl).toBe(sync.path);
        expect(JSON.parse(String(syncInit.body))).toEqual(sync.body);
      }
    }
    if (typeof expected === "function") expected(result);
    else expect(result).toEqual(expected);
  }
  if (!spec.failure) return;
  const [index, message, response] = spec.failure;
  fetchMock.mockReset();
  if (response) fetchMock.mockResolvedValueOnce(response);
  else fetchMock.mockRejectedValueOnce(new Error(message));
  await expect(calls[index]()).rejects.toThrow(message);
};

const PROVIDERS: Record<string, (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>> = {
  basecamp3: async (fetchMock) => {
    prisma.app.findUnique.mockResolvedValue({ keys: { client_id: "bc-client", client_secret: "bc-secret", user_agent: "cal-agent" } });
    const add = await import("../basecamp3/api/add");
    const addRes = await invoke(add.default as NextApiHandler);
    expect(bodyOf(addRes)).toEqual({ url: `https://launchpad.37signals.com/authorization/new?type=web_server&client_id=bc-client&redirect_uri=${WEBAPP_URL}/api/integrations/basecamp3/callback` });
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "bc-token", refresh_token: "bc-refresh" })).mockResolvedValueOnce(jsonResponse({ accounts: [{ id: 10, name: "Acme" }] }));
    const callback = await import("../basecamp3/api/callback");
    const callbackRes = await invoke(callback.default as NextApiHandler, createRequest({ query: { code: "code" } }));
    expect(queryOf(fetchCall(fetchMock)[0])).toMatchObject({ type: "web_server", client_id: "bc-client", client_secret: "bc-secret", redirect_uri: `${WEBAPP_URL}/api/integrations/basecamp3/callback`, code: "code" });
    expectFetch(fetchMock, 1, "https://launchpad.37signals.com/authorization.json", { headers: { Authorization: "Bearer bc-token", "User-Agent": "cal-agent" } });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { credentials: { create: { type: "basecamp3_other_calendar", key: { access_token: "bc-token", refresh_token: "bc-refresh", expires_at: expect.any(Number), account: { id: 10, name: "Acme" } }, appId: "basecamp3" } } },
    });
    expect(callbackRes.redirect).toHaveBeenCalledWith("/apps/installed/other?hl=basecamp3");
    fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ access_token: "new-token" }));
    prisma.credential.update.mockResolvedValue({ key: { access_token: "new-token" } });
    const { refreshAccessToken } = await import("../basecamp3/lib/helpers");
    await expect(refreshAccessToken({ id: 1, key: { refresh_token: "bc-refresh" } } as unknown as CredentialPayload)).resolves.toEqual({ access_token: "new-token" });
    const [refreshUrl, refreshInit] = fetchCall(fetchMock);
    expect(refreshUrl).toContain("type=refresh&refresh_token=bc-refresh");
    expect(refreshInit).toMatchObject({ method: "POST", headers: { "User-Agent": "cal-agent" } });
    fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, 400, "Bad Request"));
    const failed = await invoke(callback.default as NextApiHandler, createRequest({ query: { code: "bad" } }));
    expect(failed.status).toHaveBeenCalledWith(400);
    expect(bodyOf(failed)).toEqual({ message: "invalid_grant" });
  },
  sendgrid: async () => {
    const add = await import("../sendgrid/api/_getAdd");
    expect(bodyOf(await invoke(add.default as NextApiHandler))).toEqual({ url: "/apps/sendgrid/setup" });
    prisma.credential.findFirst.mockResolvedValue({ id: 1 });
    const installed = await invoke(add.default as NextApiHandler);
    expect(installed.status).toHaveBeenCalledWith(422);
    expect(bodyOf(installed)).toMatchObject({ message: "Already installed" });
    const post = await import("../sendgrid/api/_postAdd");
    const postRes = await invoke(post.default as NextApiHandler, createRequest({ method: "POST", body: { api_key: "SG.key" } }));
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "sendgrid_other_calendar", key: { encrypted: expect.stringMatching(/^[0-9a-f]+:[0-9a-f]+$/) }, userId: USER_ID, appId: "sendgrid" },
    });
    expect(bodyOf(postRes)).toEqual({ url: "/apps/installed/other?hl=sendgrid" });
    const missing = await invoke(post.default as NextApiHandler, createRequest({ method: "POST" }));
    expect(missing.status).toHaveBeenCalledWith(400);
    sendgridRequest.mockResolvedValueOnce([{}, { username: "cal" }]).mockResolvedValueOnce([{}, { errors: "down" }]);
    const check = await import("../sendgrid/api/check");
    expect(bodyOf(await invoke(check.default as NextApiHandler, createRequest({ method: "POST", body: { api_key: "SG.key" } })))).toEqual({});
    expect(sendgridRequest).toHaveBeenCalledWith({ url: "/v3/user/username", method: "GET" });
    const failed = await invoke(check.default as NextApiHandler, createRequest({ method: "POST", body: { api_key: "SG.key" } }));
    expect(failed.status).toHaveBeenCalledWith(500);
  },
  giphy: async (fetchMock) => {
    prisma.app.findUnique.mockResolvedValue({ keys: { api_key: "giphy-key" } });
    const add = await import("../giphy/api/add");
    const addRes = await invoke(add.default as NextApiHandler);
    expect(prisma.credential.create).toHaveBeenCalledWith({ data: { type: "giphy_other", key: {}, userId: USER_ID, appId: "giphy" } });
    expect(bodyOf(addRes)).toEqual({ url: "/apps/installed/other?hl=giphy" });
    prisma.user.findFirst.mockResolvedValue({ id: USER_ID, locale: "de" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ images: { fixed_height_downsampled: { url: "https://giphy.example/gif" } } }], pagination: { total_count: 5 } }));
    const search = await import("../giphy/api/search");
    const searchRes = await invoke(search.default as NextApiHandler, createRequest({ method: "POST", body: { keyword: "cats", offset: 2 } }));
    expect(queryOf(fetchCall(fetchMock)[0])).toEqual({ api_key: "giphy-key", q: "cats", limit: "1", offset: "2", rating: "g", lang: "de" });
    expect(bodyOf(searchRes)).toEqual({ image: "https://giphy.example/gif", nextOffset: 3 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { images: { fixed_height_downsampled: { url: "https://giphy.example/one.gif" } } } }));
    const get = await import("../giphy/api/get");
    const getRes = await invoke(get.default as NextApiHandler, createRequest({ method: "POST", body: { url: "https://media.giphy.com/media/abc123/giphy.gif" } }));
    expect(fetchCall(fetchMock, 1)[0]).toBe("https://api.giphy.com/v1/gifs/abc123?api_key=giphy-key");
    expect(bodyOf(getRes)).toEqual({ image: "https://giphy.example/one.gif" });
    const invalid = await invoke(get.default as NextApiHandler, createRequest({ method: "POST", body: { url: "https://example.com/not-a-gif" } }));
    expect(invalid.status).toHaveBeenCalledWith(400);
  },
  intercom: async (fetchMock) => {
    prisma.app.findUnique.mockResolvedValue({ keys: { client_id: "intercom-client", client_secret: "intercom-secret" } });
    const add = await import("../intercom/api/add");
    const addRes = await invoke(add.default as NextApiHandler);
    expect(`${new URL((bodyOf(addRes) as { url: string }).url).origin}${new URL((bodyOf(addRes) as { url: string }).url).pathname}`).toBe("https://app.intercom.com/oauth");
    expect(queryOf((bodyOf(addRes) as { url: string }).url)).toEqual({ client_id: "intercom-client", redirect_uri: `${WEBAPP_URL_FOR_OAUTH}/api/integrations/intercom/callback`, response_type: "code", state: "" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "intercom-token" })).mockResolvedValueOnce(jsonResponse({ id: "admin-1" }));
    const callback = await import("../intercom/api/callback");
    const callbackRes = await invoke(callback.default as NextApiHandler, createRequest({ query: { code: "code" } }));
    expectFetch(fetchMock, 0, "https://api.intercom.io/auth/eagle/token", { method: "POST", body: JSON.stringify({ code: "code", client_id: "intercom-client", client_secret: "intercom-secret" }) });
    expectFetch(fetchMock, 1, "https://api.intercom.io/me", { headers: { Authorization: "Bearer intercom-token" } });
    expect(prisma.credential.deleteMany).toHaveBeenCalledWith({ where: { type: "intercom_automation", key: { string_contains: "admin-1" } } });
    await vi.waitFor(() => expect(prisma.credential.create).toHaveBeenCalledWith({ data: { type: "intercom_automation", key: JSON.stringify({ access_token: "intercom-token", admin_id: "admin-1" }), userId: USER_ID, appId: "intercom" } }));
    expect(callbackRes.redirect).toHaveBeenCalledWith(`${WEBAPP_URL}/apps/installed/automation?hl=intercom`);
    const initialize = await import("../intercom/api/initialize");
    const initRes = await invoke(initialize.default as NextApiHandler, createRequest({ method: "POST", body: { card_creation_options: { submit_booking_url: "https://cal.com/jane/30min" } } }));
    expect(bodyOf(initRes)).toMatchObject({ canvas: { content: { components: expect.any(Array) } } });
    const configure = await import("../intercom/api/configure");
    const configureRes = await invoke(configure.default as NextApiHandler, createRequest({ method: "POST", body: { current_canvas: { stored_data: { submit_booking_url: "https://cal.com/jane/30min" } }, input_values: { booking_button_input: "Book", invitation_input: "Meet" } } }));
    expect(bodyOf(configureRes)).toEqual({ results: { booking_button_input: "Book", invitation_input: "Meet", submit_booking_url: "https://cal.com/jane/30min" } });
    const sheet = await import("../intercom/api/sheet");
    const sheetRes = await invoke(sheet.default as NextApiHandler, createRequest({ method: "POST", body: { sheet_values: { booking: { startTime: "2024-01-15T09:00:00.000Z" }, eventType: { title: "Planning Session" }, organizer: { name: "Jane", timeZone: "UTC" } } } }));
    expect(bodyOf(sheetRes)).toMatchObject({ canvas: { content: { components: [expect.objectContaining({ text: "Confirmed: Planning Session" }), expect.anything(), expect.objectContaining({ text: expect.stringContaining("Jane") })] } } });
    const get = await import("../intercom/api/get");
    const getRes = await invoke(get.default as NextApiHandler, createRequest({ method: "POST", query: { url: "https://cal.com/jane/30min" } }));
    expect(String(getRes.send.mock.calls[0][0])).toContain('origin: "https://cal.com"');
    const rejected = await invoke(get.default as NextApiHandler, createRequest({ method: "POST", query: { url: "https://evil.example/jane" } }));
    expect(rejected.status).toHaveBeenCalledWith(400);
    fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400, "Bad Request"));
    const failed = await invoke(callback.default as NextApiHandler, createRequest({ query: { code: "bad" } }));
    expect(failed.redirect).toHaveBeenCalledWith('/apps/installed?error={"error":"bad"}');
  },
  vital: async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: { api_key: "vital-key", mode: "sandbox", region: "us", webhook_secret: "vital-secret" } });
    vital.userCreate.mockResolvedValue({ user_id: "vital-user" });
    vital.linkCreate.mockResolvedValue({ link_token: "link-token" });
    const token = await import("../vital/api/token");
    const tokenRes = await invoke(token.default as NextApiHandler);
    expect(vital.userCreate).toHaveBeenCalledWith(`cal_${USER_ID}`);
    expect(vital.linkCreate).toHaveBeenCalledWith("vital-user", undefined, `${WEBAPP_URL}/api/integrations/vital/callback`);
    expect(prisma.credential.create).toHaveBeenCalledWith({ data: { type: "vital_other", key: { userVitalId: "vital-user" }, userId: USER_ID, appId: "vital-automation" } });
    expect(bodyOf(tokenRes)).toEqual({ token: "link-token", url: "https://link.tryvital.io/?env=sandbox&region=us" });
    vital.linkCreate.mockRejectedValueOnce(new Error("vital down"));
    const tokenFailed = await invoke(token.default as NextApiHandler);
    expect(tokenFailed.status).toHaveBeenCalledWith(400);
    expect(bodyOf(tokenFailed)).toEqual({ error: JSON.stringify(new Error("vital down")) });
    prisma.user.findFirst.mockResolvedValue({ id: USER_ID, metadata: { vitalSettings: { connected: false } } });
    const callback = await import("../vital/api/callback");
    const callbackRes = await invoke(callback.default as NextApiHandler);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { metadata: { vitalSettings: { connected: true } } } });
    expect(callbackRes.redirect).toHaveBeenCalledWith("/apps/installed/other?hl=vital-automation");
    const save = await import("../vital/api/save");
    const saveRes = await invoke(save.default as NextApiHandler, createRequest({ method: "PUT", body: { parameter: "total_sleep", sleepValue: 7 } }));
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { metadata: { vitalSettings: { connected: false, parameter: "total_sleep", sleepValue: 7 } } } });
    expect(bodyOf(saveRes)).toEqual({ connected: false });
    const settings = await import("../vital/api/settings");
    expect(bodyOf(await invoke(settings.default as NextApiHandler))).toEqual({ connected: false });
    const webhook = await import("../vital/api/webhook");
    const missing = await invoke(webhook.default as NextApiHandler, createRequest({ method: "POST" }));
    expect(missing.status).toHaveBeenCalledWith(400);
    expect(bodyOf(missing)).toMatchObject({ message: "Missing svix-signature" });
    vital.constructEvent.mockReturnValueOnce({ event_type: "other", data: {} });
    expect(bodyOf(await invoke(webhook.default as NextApiHandler, createRequest({ method: "POST", headers: { "svix-signature": "sig" }, body: { event: "ok" } })))).toEqual({ body: { event: "ok" } });
    vital.constructEvent.mockImplementationOnce(() => { throw new Error("invalid signature"); });
    const invalid = await invoke(webhook.default as NextApiHandler, createRequest({ method: "POST", headers: { "svix-signature": "bad" } }));
    expect(invalid.status).toHaveBeenCalledWith(500);
    expect(bodyOf(invalid)).toMatchObject({ message: "invalid signature" });
  },
  dub: async (fetchMock) => {
    prisma.app.findUnique.mockResolvedValue({ keys: { client_id: "dub-client", client_secret: "dub-secret", redirect_uris: "https://cal.com/callback" } });
    const add = await import("../dub/api/add");
    const addRes = await invoke(add.default as NextApiHandler, createRequest({ query: { teamId: "5" } }));
    const authorizeUrl = (bodyOf(addRes) as { url: string }).url;
    expect(`${new URL(authorizeUrl).origin}${new URL(authorizeUrl).pathname}`).toBe("https://app.dub.co/oauth/authorize");
    expect(queryOf(authorizeUrl)).toEqual({ client_id: "dub-client", redirect_uri: "https://cal.com/callback", response_type: "code", scope: "workspaces.read", state: JSON.stringify({ teamId: 5 }) });
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "dub-token", expires_in: 3600 }));
    const callback = await import("../dub/api/callback");
    const callbackRes = await invoke(callback.default as NextApiHandler, createRequest({ query: { code: "code" } }));
    expectFetch(fetchMock, 0, "https://api.dub.co/oauth/token", { method: "POST", body: new URLSearchParams({ code: "code", client_id: "dub-client", redirect_uri: "https://cal.com/callback", client_secret: "dub-secret", grant_type: "authorization_code" }).toString() });
    expect(prisma.credential.create).toHaveBeenCalledWith({ data: { type: "dub", key: { access_token: "dub-token", expiry_date: expect.any(Number) }, userId: USER_ID, appId: "dub" } });
    expect(callbackRes.redirect).toHaveBeenCalledWith("/apps/installed/analytics?hl=dub");
    const { default: BuildAnalyticsService } = await import("../dub/lib/AnalyticsService");
    await BuildAnalyticsService({ id: 1, key: { access_token: "dub-token", expiry_date: Date.now() + 3_600_000 }, userId: USER_ID } as unknown as CredentialPayload).sendEvent({ name: "Jane", email: "jane@example.com", eventName: "booking", id: "click-1" });
    expect(dubTokens.at(-1)).toBe("dub-token");
    expect(dubTrackLead).toHaveBeenCalledWith({ clickId: "click-1", customerName: "Jane", customerEmail: "jane@example.com", externalId: "jane@example.com", eventName: "booking" });
    fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ error: { message: "bad" } }, 400, "Bad Request"));
    const failed = await invoke(callback.default as NextApiHandler, createRequest({ query: { code: "bad" } }));
    expect(failed.status).toHaveBeenCalledWith(400);
    expect(bodyOf(failed)).toEqual({ message: "bad" });
  },
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  dubTokens.length = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("HUDDLE01_API_TOKEN", "huddle-api-key");
  vi.stubEnv("CALENDSO_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef");
  prisma.credential.create.mockResolvedValue({ id: 1 });
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.findFirstOrThrow.mockResolvedValue({ userId: USER_ID });
  prisma.credential.update.mockResolvedValue({});
  prisma.credential.deleteMany.mockResolvedValue({ count: 1 });
  prisma.user.findFirst.mockResolvedValue({ id: USER_ID, metadata: {} });
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: USER_ID, email: "jane@example.com" });
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID, username: "jane", email: "jane@example.com" });
  prisma.user.update.mockResolvedValue({});
  prisma.app.findUnique.mockResolvedValue({ keys: {} });
  prisma.team.findUnique.mockResolvedValue(null);
  prisma.eventType.findMany.mockResolvedValue([]);
  prisma.booking.findMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(rows)("app-store server execution: %s", (slug) => {
  it("runs the upstream server contract or records the remaining provider row", async () => {
    let executed = false;
    if (INSTALL_SLUGS.has(slug)) { await verifyInstall(slug); executed = true; }
    if (ANALYTICS_SLUGS.has(slug)) { verifyAnalytics(slug); executed = true; }
    if (VIDEOS[slug]) { await runVideo(slug, fetchMock); executed = true; }
    if (PROVIDERS[slug]) { await PROVIDERS[slug](fetchMock); executed = true; }
    if (CATALOG_SLUGS.has(slug)) { verifyCatalog(slug); executed = true; }
    if (REMAINING_SLUGS.has(slug)) { expect(executed).toBe(false); return; }
    expect(executed).toBe(true);
  });
});
