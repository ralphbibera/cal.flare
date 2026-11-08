import process from "node:process";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import { symmetricEncrypt } from "@calcom/lib/crypto";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import createFetchMock from "vitest-fetch-mock";
import closeAdd from "../api/add";
import closeCallback from "../api/callback";
import BuildCrmService from "../lib/CrmService";

vi.unmock("@calcom/lib/crypto");

const fetchMock = createFetchMock(vi);
fetchMock.enableMocks();

const ENCRYPTION_KEY = "12345678901234567890123456789012";
const CLIENT_ID = "close-client";
const CLIENT_SECRET = "close-secret";
const LEAD_ID = "lead-1";
const CONTACT_ID = "contact-1";

const { prisma } = vi.hoisted(() => {
  // biome-ignore lint/style/noProcessEnv: the service reads the key at module load
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.CALENDSO_ENCRYPTION_KEY = "12345678901234567890123456789012";
  return {
    prisma: {
      app: { findUnique: vi.fn() },
      credential: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    },
  };
});

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/lib/server/defaultResponder", () => ({
  defaultResponder: (handler: unknown) => handler,
}));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

const createResponse = () => {
  const res: MockResponse = { status: vi.fn(), json: vi.fn(), redirect: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};

const request = (overrides: Record<string, unknown>) => overrides as unknown as NextApiRequest;

const buildCredential = (
  key: Record<string, unknown>,
  overrides: Partial<CredentialPayload> = {}
): CredentialPayload =>
  ({
    id: 9,
    type: "closecom_crm",
    appId: "closecom",
    userId: 1,
    teamId: null,
    invalid: false,
    delegationCredentialId: null,
    encryptedKey: null,
    user: { email: "jane@example.com" },
    key,
    ...overrides,
  }) as CredentialPayload;

const oauthCredential = (overrides: Record<string, unknown> = {}) =>
  buildCredential({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: Date.now() + 3600_000,
    ...overrides,
  });

const apiKeyCredential = () =>
  buildCredential({
    encrypted: symmetricEncrypt(JSON.stringify({ api_key: "legacy-key" }), ENCRYPTION_KEY),
  });

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    type: "closecom_crm",
    title: "Planning",
    startTime: "2024-01-15T09:00:00Z",
    endTime: "2024-01-15T10:00:00Z",
    organizer: {
      name: "Jane",
      email: "jane@example.com",
      timeZone: "Europe/London",
      language: { translate: (key: string) => key, locale: "en" },
    },
    attendees: [
      {
        name: "Alex Doe",
        email: "alex@example.com",
        timeZone: "Europe/London",
        language: { translate: (key: string) => key, locale: "en" },
      },
    ],
    additionalNotes: "Bring the deck",
    ...overrides,
  }) as CalendarEvent;

const SEARCH_RESULT = {
  data: [
    {
      __object_type: "contact",
      id: CONTACT_ID,
      name: "Alex Doe",
      lead_id: LEAD_ID,
      emails: [{ email: "alex@example.com", type: "office" }],
    },
  ],
  cursor: null,
};

const queueActivitySetup = () => {
  fetchMock.mockResponseOnce(
    JSON.stringify({ data: [{ name: `From ${APP_NAME}`, id: LEAD_ID }], cursor: null })
  );
  fetchMock.mockResponseOnce(JSON.stringify(SEARCH_RESULT));
  fetchMock.mockResponseOnce(JSON.stringify({ data: [], cursor: null }));
  fetchMock.mockResponseOnce(JSON.stringify({ id: "activity-type-1" }));
  for (let field = 1; field <= 5; field++) {
    fetchMock.mockResponseOnce(JSON.stringify({ id: `field-${field}` }));
  }
};

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.resetMocks();
  process.env.CLOSECOM_CLIENT_ID = CLIENT_ID;
  process.env.CLOSECOM_CLIENT_SECRET = CLIENT_SECRET;
  prisma.app.findUnique.mockResolvedValue({ keys: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
  prisma.credential.create.mockResolvedValue({ id: 9 });
  prisma.credential.findFirst.mockResolvedValue({ id: 9 });
  prisma.credential.update.mockResolvedValue({});
});

describe("Close.com install", () => {
  it("returns the OAuth URL without exposing the client secret", async () => {
    const res = createResponse();

    await closeAdd(
      request({ method: "GET", query: {}, session: { user: { id: 1 } } }),
      res as unknown as NextApiResponse
    );

    const payload = res.json.mock.calls[0][0] as { url: string };
    const url = new URL(payload.url);
    expect(url.origin).toBe("https://app.close.com");
    expect(url.pathname).toBe("/oauth2/authorize/");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${WEBAPP_URL}/api/integrations/closecom/callback`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("");
    expect(payload).not.toHaveProperty("key");
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("requires a session and a configured client id", async () => {
    const anonymous = createResponse();
    await closeAdd(request({ method: "GET", query: {} }), anonymous as unknown as NextApiResponse);
    expect(anonymous.status).toHaveBeenCalledWith(401);

    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    const unconfigured = createResponse();
    await closeAdd(
      request({ method: "GET", query: {}, session: { user: { id: 1 } } }),
      unconfigured as unknown as NextApiResponse
    );
    expect(unconfigured.status).toHaveBeenCalledWith(400);
    expect(unconfigured.json).toHaveBeenCalledWith({ message: "Close.com client_id missing." });
  });
});

describe("Close.com OAuth callback", () => {
  it("stores the OAuth token object and redirects to the installed app", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    );
    const res = createResponse();

    await closeCallback(
      request({ method: "GET", query: { code: "auth-code" }, session: { user: { id: 1 } } }),
      res as unknown as NextApiResponse
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.close.com/oauth2/token/");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toBe(
      `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=authorization_code&code=auth-code&redirect_uri=${encodeURIComponent(
        `${WEBAPP_URL}/api/integrations/closecom/callback`
      )}`
    );
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; appId: string; userId: number; key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({ type: "closecom_crm", appId: "closecom", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
    });
    expect(stored.data.key.expires_at).toBeGreaterThan(Date.now());
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/crm?hl=closecom");
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("new-access");
  });

  it("redirects with the provider failure without creating a credential", async () => {
    fetchMock.mockResponseOnce("denied", { status: 401 });
    const res = createResponse();

    await closeCallback(
      request({ method: "GET", query: { code: "auth-code" }, session: { user: { id: 1 } } }),
      res as unknown as NextApiResponse
    );

    expect(res.redirect).toHaveBeenCalledWith(
      "/apps/installed/crm?hl=closecom?error=Error getting close.com access token"
    );
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a code or session", async () => {
    await expect(
      closeCallback(
        request({ method: "GET", query: {}, session: { user: { id: 1 } } }),
        createResponse() as unknown as NextApiResponse
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      closeCallback(
        request({ method: "GET", query: { code: "auth-code" } }),
        createResponse() as unknown as NextApiResponse
      )
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Close.com credentials", () => {
  it("decrypts the legacy API key credential and uses Basic auth", async () => {
    fetchMock.mockResponseOnce(JSON.stringify(SEARCH_RESULT));

    await BuildCrmService(apiKeyCredential()).getContacts({ emails: "alex@example.com" });

    const [, init] = fetchMock.mock.calls[0];
    // Workers: Buffer supplies the Basic auth encoding under nodejs_compat.
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("legacy-key:").toString("base64")}`,
    });
  });

  it("rejects a credential without an API key or access token", () => {
    expect(() => BuildCrmService(buildCredential({}))).toThrow("Invalid credentials for userId 1");
  });

  it("refreshes an expired OAuth token and persists the replacement", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        expires_in: 3600,
      })
    );
    fetchMock.mockResponseOnce(JSON.stringify(SEARCH_RESULT));

    await BuildCrmService(oauthCredential({ expires_at: Date.now() - 1000 })).getContacts({
      emails: "alex@example.com",
    });

    const [refreshUrl, refreshInit] = fetchMock.mock.calls[0];
    expect(refreshUrl).toBe("https://api.close.com/oauth2/token/");
    expect(String(refreshInit?.body)).toBe(
      `grant_type=refresh_token&refresh_token=refresh-token&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
    );
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: {
        key: expect.objectContaining({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
        }),
      },
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer refreshed-access",
    });
  });

  it("fails the request when the refresh token is rejected", async () => {
    fetchMock.mockResponseOnce("invalid", { status: 401 });

    await expect(
      BuildCrmService(oauthCredential({ expires_at: Date.now() - 1000 })).getContacts({
        emails: "alex@example.com",
      })
    ).rejects.toThrow("Failed to refresh token");
    expect(prisma.credential.update).not.toHaveBeenCalled();
  });
});

describe("Close.com contacts", () => {
  it("searches contacts by email and creates a lead with its first contact", async () => {
    fetchMock.mockResponseOnce(JSON.stringify(SEARCH_RESULT));
    const contacts = await BuildCrmService(oauthCredential()).getContacts({
      emails: ["alex@example.com"],
    });

    expect(contacts).toEqual([{ id: CONTACT_ID, email: "alex@example.com", name: "Alex Doe" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.close.com/api/v1/data/search/");
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('"value":"alex@example.com"');

    fetchMock.mockResponseOnce(
      JSON.stringify({
        id: LEAD_ID,
        contacts: [{ id: CONTACT_ID, emails: [{ email: "alex@example.com", type: "office" }] }],
      })
    );
    const created = await BuildCrmService(oauthCredential()).createContacts([
      { name: "Alex Doe", email: "alex@example.com" },
    ]);

    expect(created).toEqual([{ id: CONTACT_ID, email: "alex@example.com" }]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.close.com/api/v1/lead/");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      contacts: [{ name: "Alex Doe", email: "alex@example.com" }],
    });
  });

  it("surfaces a provider error", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ error: "unauthorized" }), { status: 401 });

    await expect(
      BuildCrmService(oauthCredential()).getContacts({ emails: "alex@example.com" })
    ).rejects.toThrow("[Close.com app] An error has occurred: 401");
  });
});

describe("Close.com custom activities", () => {
  const CUSTOM_ACTIVITY_BODY = {
    custom_activity_type_id: "activity-type-1",
    lead_id: LEAD_ID,
    "custom.field-1": null,
    "custom.field-2": "2024-01-15T09:00:00Z",
    "custom.field-3": "Europe/London",
    "custom.field-4": CONTACT_ID,
    "custom.field-5": "Bring the deck",
  };

  it("creates the custom activity type, fields and booking activity", async () => {
    queueActivitySetup();
    fetchMock.mockResponseOnce(JSON.stringify({ id: "activity-1" }));

    const result = await BuildCrmService(oauthCredential()).createEvent(buildEvent());

    expect(result).toMatchObject({
      uid: "activity-1",
      id: "activity-1",
      type: "closecom_other_calendar",
      success: true,
    });
    expect(fetchMock.mock.calls[9][0]).toBe("https://api.close.com/api/v1/activity/custom/");
    expect(JSON.parse(String(fetchMock.mock.calls[9][1]?.body))).toEqual(CUSTOM_ACTIVITY_BODY);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({
      name: `${APP_NAME} Activity`,
    });
  });

  it("updates and deletes the activity through its uid", async () => {
    queueActivitySetup();
    fetchMock.mockResponseOnce(JSON.stringify({ id: "activity-1" }));
    fetchMock.mockResponseOnce(JSON.stringify({ id: "activity-1" }));

    await expect(BuildCrmService(oauthCredential()).updateEvent("activity-1", buildEvent())).resolves.toEqual(
      { id: "activity-1" }
    );
    expect(fetchMock.mock.calls[10][0]).toBe("https://api.close.com/api/v1/activity/custom/activity-1/");
    expect(fetchMock.mock.calls[10][1]?.method).toBe("put");

    fetchMock.mockResponseOnce(JSON.stringify({ id: "activity-1" }));
    await BuildCrmService(oauthCredential()).deleteEvent("activity-1");
    expect(fetchMock.mock.calls[11][0]).toBe("https://api.close.com/api/v1/activity/custom/activity-1/");
    expect(fetchMock.mock.calls[11][1]?.method).toBe("delete");
  });
});
