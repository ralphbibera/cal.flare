import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addBasecamp from "../api/add";
import callback from "../api/callback";
import projectMutation from "../api/projectMutation";
import projects from "../api/projects";
import BuildCalendarService from "../lib/CalendarService";

const CLIENT_ID = "basecamp-client-id";
const CLIENT_SECRET = "basecamp-client-secret";
const USER_AGENT = "Cal.flare (help@cal.com)";
const ACCESS_TOKEN = "basecamp-access-token";
const REFRESH_TOKEN = "basecamp-refresh-token";
const APP_URL = "http://app.cal.local:3000";

const { prisma, refreshAccessToken } = vi.hoisted(() => ({
  prisma: {
    credential: { findFirst: vi.fn(), update: vi.fn() },
    user: { findFirstOrThrow: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  refreshAccessToken: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("../../_utils/getAppKeysFromSlug", () => ({
  default: vi.fn(async () => ({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    user_agent: USER_AGENT,
  })),
}));
vi.mock("../lib/helpers", () => ({ refreshAccessToken }));

const translate = ((key: string) => key) as never;

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "Consultation",
  title: "Planning",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  uid: "booking-1",
  organizer: {
    id: 1,
    name: "Jane",
    email: "jane@example.com",
    timeZone: "UTC",
    language: { translate, locale: "en" },
  },
  attendees: [
    {
      name: "Alex",
      email: "alex@example.com",
      timeZone: "UTC",
      language: { translate, locale: "en" },
    },
  ],
  ...overrides,
});

const credentialKey = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expires_at: Date.now() + 86_400_000,
  expires_in: 86_400,
  account: { id: 99, href: "https://3.basecampapi.com/99", name: "Acme" },
  projectId: 42,
  scheduleId: 7,
};

const buildCredential = (key: Record<string, unknown> = credentialKey): CredentialPayload => ({
  id: 1,
  type: "basecamp3",
  appId: "basecamp3",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: "jane@example.com" },
  key,
});

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    body: {},
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    setHeader: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};

const buildResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  prisma.user.findFirstOrThrow.mockResolvedValue({ id: 1 });
  prisma.user.findUnique.mockResolvedValue({ timeZone: "Europe/London" });
  prisma.credential.update.mockResolvedValue({});
  prisma.credential.findFirst.mockResolvedValue({ id: 1, key: credentialKey });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Basecamp 3 OAuth install", () => {
  it("sends the user to Basecamp with the web-server flow and callback URL", async () => {
    const res = createResponse();

    await addBasecamp(buildRequest(), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://launchpad.37signals.com/authorization/new"
    );
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      type: "web_server",
      client_id: CLIENT_ID,
      redirect_uri: `${APP_URL}/api/integrations/basecamp3/callback`,
    });
    expect(url).not.toContain(CLIENT_SECRET);
    expect(prisma.user.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true },
    });
  });

  it("exchanges the code, stores the account and tokens, and redirects to calendar apps", async () => {
    const startedAt = Date.now();
    fetchMock
      .mockResolvedValueOnce(
        buildResponse({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 86_400,
        })
      )
      .mockResolvedValueOnce(
        buildResponse({
          accounts: [{ id: 99, href: "https://3.basecampapi.com/99", name: "Acme", product: "bc3" }],
        })
      );
    const res = createResponse();

    await callback(buildRequest({ query: { code: "auth-code" } }), res as unknown as NextApiResponse);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    const tokenParams = new URL(tokenUrl).searchParams;
    expect(tokenParams.get("type")).toBe("web_server");
    expect(tokenParams.get("client_id")).toBe(CLIENT_ID);
    expect(tokenParams.get("client_secret")).toBe(CLIENT_SECRET);
    expect(tokenParams.get("code")).toBe("auth-code");
    expect(tokenParams.get("redirect_uri")).toBe(`${APP_URL}/api/integrations/basecamp3/callback`);
    expect(tokenOptions.method).toBe("POST");

    const [authUrl, authOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(authUrl).toBe("https://launchpad.37signals.com/authorization.json");
    expect(authOptions).toMatchObject({
      headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const update = prisma.user.update.mock.calls[0][0] as {
      where: { id: number };
      data: { credentials: { create: { type: string; appId: string; key: Record<string, unknown> } } };
    };
    expect(update.where).toEqual({ id: 1 });
    expect(update.data.credentials.create).toMatchObject({
      type: "basecamp3_other_calendar",
      appId: "basecamp3",
    });
    expect(update.data.credentials.create.key).toMatchObject({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      account: { id: 99, name: "Acme" },
    });
    expect(update.data.credentials.create.key.expires_at).toBeGreaterThanOrEqual(startedAt + 1_209_500_000);
    expect(update.data.credentials.create.key.expires_at).toBeLessThanOrEqual(startedAt + 1_209_700_000);
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/other?hl=basecamp3");
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls])).not.toContain(REFRESH_TOKEN);
  });
});

describe("Basecamp 3 project selection", () => {
  it("lists projects from the account href with the stored token", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse([{ id: 1, name: "Client work" }]));
    const res = createResponse();

    await projects(buildRequest(), res as unknown as NextApiResponse);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://3.basecampapi.com/99/projects.json");
    expect(options).toMatchObject({
      headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(res.json).toHaveBeenCalledWith({
      currentProject: 42,
      projects: [{ id: 1, name: "Client work" }],
    });
  });

  it("stores the selected project and its schedule dock id", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        dock: [
          { id: 5, name: "schedule" },
          { id: 6, name: "todos" },
        ],
      })
    );
    const res = createResponse();

    await projectMutation(
      buildRequest({ method: "POST", body: { projectId: "123" } }),
      res as unknown as NextApiResponse
    );

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://3.basecampapi.com/99/projects/123.json");
    expect(options).toMatchObject({
      headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { key: { ...credentialKey, projectId: 123, scheduleId: 5 } },
    });
    expect(res.json).toHaveBeenCalledWith({ message: "Updated project successfully" });
  });
});

describe("Basecamp 3 calendar events", () => {
  it("creates a schedule entry with the Cal.flare summary and attendee description", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ id: 321 }));
    const calendar = BuildCalendarService(buildCredential());

    const result = await calendar.createEvent(buildEvent());

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://3.basecampapi.com/99/buckets/42/schedules/7/entries.json");
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(options.body as string) as Record<string, string>;
    expect(body.summary).toBe("Cal.flare: Planning");
    expect(body.starts_at).toBe("2024-01-15T09:00:00.000Z");
    expect(body.ends_at).toBe("2024-01-15T10:00:00.000Z");
    expect(body.description).toContain("Event title: Planning");
    expect(body.description).toContain("alex@example.com");
    expect(result).toEqual({
      id: 321,
      uid: 321,
      type: "basecamp3",
      password: "",
      url: "",
      additionalInfo: { meetingJson: { id: 321 } },
    });
  });

  it("updates and trashes the schedule entry by booking uid", async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ id: 321 })).mockResolvedValueOnce(buildResponse({}));
    const calendar = BuildCalendarService(buildCredential());

    const updated = await calendar.updateEvent("321", buildEvent());
    await calendar.deleteEvent("321");

    const [updateUrl, updateOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(updateUrl).toBe("https://3.basecampapi.com/99/buckets/42/schedule_entries/321.json");
    expect(updateOptions.method).toBe("PUT");
    expect(updated).toMatchObject({ id: 321, uid: 321, type: "Consultation" });

    const [deleteUrl, deleteOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(deleteUrl).toBe("https://3.basecampapi.com/99/buckets/42/recordings/321/status/trashed.json");
    expect(deleteOptions.method).toBe("PUT");
  });
});
