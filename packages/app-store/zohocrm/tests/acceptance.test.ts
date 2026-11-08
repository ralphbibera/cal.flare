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
  const log: Record<string, unknown> = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  log.getSubLogger = () => log;
  return { default: { ...log, getSubLogger: () => log } };
});

const requests: InternalAxiosRequestConfig[] = [];
let handleRequest: (request: InternalAxiosRequestConfig) => { status?: number; data: unknown } = () => ({
  data: {},
});

axios.defaults.adapter = async (config) => {
  requests.push(config);
  const result = handleRequest(config);
  return { data: result.data, status: result.status ?? 200, statusText: "OK", headers: {}, config };
};

const response = () => {
  const res = { status: vi.fn(), json: vi.fn(), redirect: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};
const request = (overrides: Record<string, unknown>) => overrides as unknown as NextApiRequest;

const credential = (expiry = Date.now() + 3600_000): CredentialPayload =>
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
      expiryDate: expiry,
      accountServer: ACCOUNTS_SERVER,
      api_domain: "https://www.zohoapis.eu",
      token_type: "Bearer",
      expires_in: 3600,
    },
  }) as CredentialPayload;

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
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

const CONTACTS = [{ id: "contact-1", email: "alex@example.com" }];

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

describe("Zoho CRM install and callback", () => {
  it("returns the consent URL without a session or client secret", async () => {
    const res = response();

    await zohoAdd(request({ method: "GET", query: {} }), res as unknown as NextApiResponse);

    const payload = res.json.mock.calls[0][0] as { url: string };
    const url = new URL(payload.url);
    expect(url.origin).toBe("https://accounts.zoho.com");
    expect(url.pathname).toBe("/oauth/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${WEBAPP_URL}/api/integrations/zohocrm/callback`);
    expect(url.searchParams.getAll("scope")).toEqual([
      "ZohoCRM.modules.ALL",
      "ZohoCRM.users.READ",
      "AaaServer.profile.READ",
    ]);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(payload).not.toHaveProperty("key");
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("rejects a missing client id", async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    const res = response();

    await zohoAdd(request({ method: "GET", query: {} }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "zohocrm client id missing." });
  });

  it("exchanges the code, stores the regional token and redirects", async () => {
    handleRequest = () => ({
      data: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        api_domain: "https://www.zohoapis.eu",
        token_type: "Bearer",
      },
    });
    const res = response();
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
    expect(Object.fromEntries(new URLSearchParams(String(requests[0].data)))).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: `${WEBAPP_URL}/api/integrations/zohocrm/callback`,
      code: "auth-code",
    });
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({ type: "zohocrm_crm", appId: "zohocrm", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      accountServer: ACCOUNTS_SERVER,
    });
    // Baseline stores seconds where milliseconds are read, so the first request refreshes.
    expect(stored.data.key.expiryDate).toBeGreaterThanOrEqual(startedAt + 3600);
    expect(stored.data.key.expiryDate).toBeLessThanOrEqual(Date.now() + 3600);
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/other?hl=zohocrm");
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("new-access");
  });

  it("rejects an unapproved accounts server and a missing session without exchanging", async () => {
    const unapproved = response();
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

    const anonymous = response();
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

  it("propagates a failed code exchange without storing a credential", async () => {
    handleRequest = () => {
      throw new Error("token endpoint rejected the code");
    };

    await expect(
      zohoCallback(
        request({
          method: "GET",
          query: { code: "expired", "accounts-server": ACCOUNTS_SERVER },
          session: { user: { id: 1 } },
        }),
        response() as unknown as NextApiResponse
      )
    ).rejects.toThrow("token endpoint rejected the code");
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Zoho CRM contacts", () => {
  it("searches by email and creates contacts with split names", async () => {
    handleRequest = () => ({ data: { data: [{ id: "contact-1", email: "alex@example.com" }] } });
    const contacts = await BuildCrmService(credential()).getContacts({ emails: ["alex@example.com"] });

    expect(contacts).toEqual(CONTACTS);
    expect(requests[0].url).toBe(
      "https://www.zohoapis.com/crm/v3/Contacts/search?criteria=((Email:equals:alex@example.com))"
    );
    expect(requests[0].headers.get("authorization")).toBe("Zoho-oauthtoken access-token");

    handleRequest = () => ({
      data: {
        data: [
          { id: "contact-1", email: "alex@example.com" },
          { id: "contact-2", email: "sam@example.com" },
        ],
      },
    });
    const created = await BuildCrmService(credential()).createContacts([
      { name: "Alex Doe", email: "alex@example.com" },
      { name: "Sam", email: "sam@example.com" },
    ]);

    expect(created).toHaveLength(2);
    expect(requests[1].url).toBe("https://www.zohoapis.com/crm/v3/Contacts");
    expect(JSON.parse(String(requests[1].data))).toEqual({
      data: [
        { First_Name: "Alex", Last_Name: "Doe", Email: "alex@example.com" },
        { First_Name: "Sam", Last_Name: "-", Email: "sam@example.com" },
      ],
    });
  });

  it("returns no contacts when the search fails and keeps the hardcoded domain", async () => {
    handleRequest = () => {
      throw new Error("zoho unavailable");
    };

    await expect(BuildCrmService(credential()).getContacts({ emails: "alex@example.com" })).resolves.toEqual(
      []
    );
    expect(requests[0].url).toContain("https://www.zohoapis.com/crm/v3/Contacts/search");
  });
});

describe("Zoho CRM events", () => {
  it("creates, updates and deletes the booking event", async () => {
    handleRequest = () => ({
      data: { data: [{ status: "success", details: { id: "event-1" } }] },
    });
    const created = await BuildCrmService(credential()).createEvent(event(), CONTACTS);

    expect(created).toMatchObject({ uid: "event-1", id: "event-1", type: "zohocrm_crm" });
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

    await BuildCrmService(credential()).updateEvent("event-1", event({ title: "Moved" }));
    expect(requests[1].url).toBe("https://www.zohoapis.com/crm/v3/Events");
    expect(requests[1].method).toBe("put");
    expect(JSON.parse(String(requests[1].data))).toMatchObject({
      data: [{ id: "event-1", Event_Title: "Moved" }],
    });

    await BuildCrmService(credential()).deleteEvent("event-1");
    expect(requests[2].url).toBe("https://www.zohoapis.com/crm/v3/Events?ids=event-1");
    expect(requests[2].method).toBe("delete");
  });

  it("rejects an event Zoho does not confirm", async () => {
    handleRequest = () => ({ data: { data: [{ status: "error", code: "INVALID_DATA" }] } });

    await expect(BuildCrmService(credential()).createEvent(event(), CONTACTS)).rejects.toBe(
      "Something went wrong when creating a meeting in ZohoCRM"
    );
  });
});

describe("Zoho CRM token lifecycle", () => {
  it("refreshes an expired token against the stored accounts server and persists it", async () => {
    handleRequest = (config) =>
      config.url === `${ACCOUNTS_SERVER}/oauth/v2/token`
        ? { data: { access_token: "refreshed-access", expires_in: 3600 } }
        : { data: { data: [{ id: "contact-1", email: "alex@example.com" }] } };

    await BuildCrmService(credential(Date.now() - 1000)).getContacts({ emails: "alex@example.com" });

    expect(requests[0].url).toBe(`${ACCOUNTS_SERVER}/oauth/v2/token`);
    expect(Object.fromEntries(new URLSearchParams(String(requests[0].data)))).toEqual({
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
