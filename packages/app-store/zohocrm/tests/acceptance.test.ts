import { WEBAPP_URL } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { InternalAxiosRequestConfig } from "axios";
import axios from "axios";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zohoAdd from "../api/add";
import zohoCallback from "../api/callback";
import BuildCrmService from "../lib/CrmService";

const CLIENT_ID = "zoho-client";
const CLIENT_SECRET = "zoho-secret";
const ACCOUNTS_SERVER = "https://accounts.zoho.eu";
const CREDENTIAL_ID = 51;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    app: { findUnique: vi.fn() },
    credential: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/lib/logger", () => {
  const subLogger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { default: { ...subLogger, getSubLogger: () => subLogger } };
});

const requests: InternalAxiosRequestConfig[] = [];
let handleRequest: (request: InternalAxiosRequestConfig) => { status?: number; data: unknown } = () => ({
  data: {},
});

axios.defaults.adapter = async (config) => {
  requests.push(config);
  const result = handleRequest(config);
  return {
    data: result.data,
    status: result.status ?? 200,
    statusText: "OK",
    headers: {},
    config,
  };
};

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

const buildCredential = (expiryDate = Date.now() + 3600_000): CredentialPayload =>
  ({
    id: CREDENTIAL_ID,
    type: "zohocrm_crm",
    appId: "zohocrm",
    userId: 1,
    teamId: null,
    invalid: false,
    delegationCredentialId: null,
    encryptedKey: null,
    user: { email: "jane@example.com" },
    key: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expiryDate,
      accountServer: ACCOUNTS_SERVER,
      api_domain: "https://www.zohoapis.eu",
      token_type: "Bearer",
      scope: "ZohoCRM.modules.ALL",
      expires_in: 3600,
    },
  }) as CredentialPayload;

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    type: "zohocrm_crm",
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
        name: "Alex",
        email: "alex@example.com",
        timeZone: "Europe/London",
        language: { translate: (key: string) => key, locale: "en" },
      },
    ],
    additionalNotes: "Bring the deck",
    location: "https://meet.example.com/planning",
    ...overrides,
  }) as CalendarEvent;

beforeEach(() => {
  vi.resetAllMocks();
  requests.length = 0;
  handleRequest = () => ({ data: {} });
  prisma.app.findUnique.mockResolvedValue({
    keys: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
  });
  prisma.credential.create.mockResolvedValue({ id: CREDENTIAL_ID });
  prisma.credential.update.mockResolvedValue({});
});

describe("Zoho CRM install", () => {
  it("returns the authorization URL without requiring a session", async () => {
    // Workers: api/_getAdd.ts:2 imports node:querystring, available through the nodejs_compat flag.
    const res = createResponse();

    await zohoAdd(request({ method: "GET", query: {} }), res as unknown as NextApiResponse);

    const url = new URL(res.json.mock.calls[0][0].url as string);
    expect(url.origin).toBe("https://accounts.zoho.com");
    expect(url.pathname).toBe("/oauth/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(`${WEBAPP_URL}/api/integrations/zohocrm/callback`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.getAll("scope")).toEqual([
      "ZohoCRM.modules.ALL",
      "ZohoCRM.users.READ",
      "AaaServer.profile.READ",
    ]);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("rejects a missing client id and non-GET methods", async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    const unconfigured = createResponse();
    await zohoAdd(request({ method: "GET", query: {} }), unconfigured as unknown as NextApiResponse);
    expect(unconfigured.status).toHaveBeenCalledWith(400);
    expect(unconfigured.json).toHaveBeenCalledWith({ message: "zohocrm client id missing." });

    const wrongMethod = createResponse();
    await zohoAdd(request({ method: "POST", query: {} }), wrongMethod as unknown as NextApiResponse);
    expect(wrongMethod.status).toHaveBeenCalledWith(405);
  });
});

describe("Zoho CRM OAuth callback", () => {
  it("exchanges the code and stores the region-specific token", async () => {
    handleRequest = () => ({
      data: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        api_domain: "https://www.zohoapis.eu",
        token_type: "Bearer",
        scope: "ZohoCRM.modules.ALL",
      },
    });
    const res = createResponse();
    const startedAt = Date.now();

    await zohoCallback(
      request({
        method: "GET",
        query: { code: "auth-code", "accounts-server": ACCOUNTS_SERVER },
        session: { user: { id: 1 } },
      }),
      res as unknown as NextApiResponse
    );

    expect(requests[0].url).toBe(`${ACCOUNTS_SERVER}/oauth/v2/token`);
    expect(requests[0].method).toBe("post");
    expect(requests[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded;charset=utf-8");
    const sent = new URLSearchParams(String(requests[0].data));
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: `${WEBAPP_URL}/api/integrations/zohocrm/callback`,
      code: "auth-code",
    });
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; appId: string; userId: number; key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({ type: "zohocrm_crm", appId: "zohocrm", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      accountServer: ACCOUNTS_SERVER,
    });
    // Baseline adds 60 * 60 without a millisecond conversion, so the first request refreshes.
    expect(stored.data.key.expiryDate).toBeGreaterThanOrEqual(startedAt + 3600);
    expect(stored.data.key.expiryDate).toBeLessThanOrEqual(Date.now() + 3600);
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/other?hl=zohocrm");
  });

  it("rejects an unapproved accounts server and a missing session", async () => {
    const unapproved = createResponse();
    await zohoCallback(
      request({
        method: "GET",
        query: { code: "auth-code", "accounts-server": "https://accounts.zoho.example" },
        session: { user: { id: 1 } },
      }),
      unapproved as unknown as NextApiResponse
    );
    expect(unapproved.status).toHaveBeenCalledWith(400);
    expect(unapproved.json).toHaveBeenCalledWith({ message: "`accounts-server` is not authorized" });

    const anonymous = createResponse();
    await zohoCallback(
      request({
        method: "GET",
        query: { code: "auth-code", "accounts-server": ACCOUNTS_SERVER },
      }),
      anonymous as unknown as NextApiResponse
    );
    expect(anonymous.status).toHaveBeenCalledWith(401);
    expect(requests).toHaveLength(0);
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("propagates a failed code exchange", async () => {
    handleRequest = () => {
      throw new Error("token endpoint rejected the code");
    };

    await expect(
      zohoCallback(
        request({
          method: "GET",
          query: { code: "expired-code", "accounts-server": ACCOUNTS_SERVER },
          session: { user: { id: 1 } },
        }),
        createResponse() as unknown as NextApiResponse
      )
    ).rejects.toThrow("token endpoint rejected the code");
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Zoho CRM contacts", () => {
  it("searches contacts with the stored access token", async () => {
    handleRequest = () => ({ data: { data: [{ id: "contact-1", email: "alex@example.com" }] } });

    const contacts = await BuildCrmService(buildCredential()).getContacts({
      emails: ["alex@example.com"],
    });

    expect(contacts).toEqual([{ id: "contact-1", email: "alex@example.com" }]);
    expect(requests[0].url).toBe(
      "https://www.zohoapis.com/crm/v3/Contacts/search?criteria=((Email:equals:alex@example.com))"
    );
    expect(requests[0].headers.get("authorization")).toBe("Zoho-oauthtoken access-token");
  });

  it("creates contacts with the name split into first and last name", async () => {
    handleRequest = () => ({
      data: {
        data: [
          { id: "contact-1", email: "alex@example.com" },
          { id: "contact-2", email: "sam@example.com" },
        ],
      },
    });

    const contacts = await BuildCrmService(buildCredential()).createContacts([
      { name: "Alex Doe", email: "alex@example.com" },
      { name: "Sam", email: "sam@example.com" },
    ]);

    expect(contacts).toEqual([
      { id: "contact-1", email: "alex@example.com" },
      { id: "contact-2", email: "sam@example.com" },
    ]);
    expect(requests[0].url).toBe("https://www.zohoapis.com/crm/v3/Contacts");
    expect(JSON.parse(String(requests[0].data))).toEqual({
      data: [
        { First_Name: "Alex", Last_Name: "Doe", Email: "alex@example.com" },
        { First_Name: "Sam", Last_Name: "-", Email: "sam@example.com" },
      ],
    });
  });

  it("returns no contacts when the search fails and still queries the hardcoded domain", async () => {
    handleRequest = () => {
      throw new Error("zoho unavailable");
    };

    await expect(
      BuildCrmService(buildCredential()).getContacts({ emails: "alex@example.com" })
    ).resolves.toEqual([]);
    expect(requests[0].url).toContain("https://www.zohoapis.com/crm/v3/Contacts/search");
  });
});

describe("Zoho CRM events", () => {
  it("creates the booking event for the first contact", async () => {
    handleRequest = () => ({
      data: { data: [{ status: "success", details: { id: "event-1" } }] },
    });

    const result = await BuildCrmService(buildCredential()).createEvent(buildEvent(), [
      { id: "contact-1", email: "alex@example.com" },
    ]);

    expect(result).toMatchObject({ uid: "event-1", id: "event-1", type: "zohocrm_crm" });
    expect(requests[0].url).toBe("https://www.zohoapis.com/crm/v3/Events");
    expect(JSON.parse(String(requests[0].data))).toEqual({
      data: [
        {
          Event_Title: "Planning",
          Start_DateTime: "2024-01-15T09:00:00+00:00",
          End_DateTime: "2024-01-15T10:00:00+00:00",
          Description:
            "<b>invitee_timezone:</b> Europe/London<br><br><b>share_additional_notes</b><br>Bring the deck",
          Venue: "https://meet.example.com/planning",
          Who_Id: "contact-1",
        },
      ],
    });
  });

  it("updates and deletes events by id", async () => {
    handleRequest = () => ({ data: { data: [{ status: "success" }] } });

    await BuildCrmService(buildCredential()).updateEvent("event-1", buildEvent({ title: "Moved" }));
    expect(requests[0].url).toBe("https://www.zohoapis.com/crm/v3/Events");
    expect(requests[0].method).toBe("put");
    expect(JSON.parse(String(requests[0].data))).toMatchObject({
      data: [{ id: "event-1", Event_Title: "Moved" }],
    });

    await BuildCrmService(buildCredential()).deleteEvent("event-1");
    expect(requests[1].url).toBe("https://www.zohoapis.com/crm/v3/Events?ids=event-1");
    expect(requests[1].method).toBe("delete");
  });

  it("rejects an event that Zoho does not confirm", async () => {
    handleRequest = () => ({ data: { data: [{ status: "error", code: "INVALID_DATA" }] } });

    await expect(
      BuildCrmService(buildCredential()).createEvent(buildEvent(), [
        { id: "contact-1", email: "alex@example.com" },
      ])
    ).rejects.toBe("Something went wrong when creating a meeting in ZohoCRM");
  });
});

describe("Zoho CRM token lifecycle", () => {
  it("refreshes an expired token against the stored accounts server", async () => {
    handleRequest = (config) => {
      if (config.url === `${ACCOUNTS_SERVER}/oauth/v2/token`) {
        return { data: { access_token: "refreshed-access", expires_in: 3600 } };
      }
      return { data: { data: [{ id: "contact-1", email: "alex@example.com" }] } };
    };

    await BuildCrmService(buildCredential(Date.now() - 1000)).getContacts({
      emails: "alex@example.com",
    });

    const refresh = requests[0];
    expect(refresh.url).toBe(`${ACCOUNTS_SERVER}/oauth/v2/token`);
    expect(Object.fromEntries(new URLSearchParams(String(refresh.data)))).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: "refresh-token",
    });
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: CREDENTIAL_ID },
      data: {
        key: expect.objectContaining({
          access_token: "refreshed-access",
          refresh_token: "refresh-token",
          accountServer: ACCOUNTS_SERVER,
        }),
      },
    });
    expect(requests[1].headers.get("authorization")).toBe("Zoho-oauthtoken refreshed-access");
  });
});
