import { WEBAPP_URL } from "@calcom/lib/constants";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { InternalAxiosRequestConfig } from "axios";
import axios from "axios";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import biginAdd from "../api/add";
import biginCallback from "../api/callback";
import BuildCrmService from "../lib/CrmService";

const CLIENT_ID = "bigin-client";
const CLIENT_SECRET = "bigin-secret";
const ACCOUNTS_SERVER = "https://accounts.zoho.in";
const API_DOMAIN = "https://www.zohoapis.in";
const CREDENTIAL_ID = 61;

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
    type: "zoho-bigin_crm",
    appId: "zoho-bigin",
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
      api_domain: API_DOMAIN,
      token_type: "Bearer",
      expires_in: 3600,
    },
  }) as CredentialPayload;

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    type: "zoho-bigin_crm",
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

describe("Zoho Bigin install and callback", () => {
  it("returns the consent URL without a session or client secret", async () => {
    const res = response();

    await biginAdd(request({ method: "GET", query: {} }), res as unknown as NextApiResponse);

    const payload = res.json.mock.calls[0][0] as { url: string };
    const url = new URL(payload.url);
    expect(url.origin).toBe("https://accounts.zoho.com");
    expect(url.pathname).toBe("/oauth/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${WEBAPP_URL}/api/integrations/zoho-bigin/callback`);
    expect(url.searchParams.get("scope")).toBe("ZohoBigin.modules.events.ALL,ZohoBigin.modules.contacts.ALL");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(payload).not.toHaveProperty("key");
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("rejects a missing client id and a non-GET request", async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    const missing = response();
    await biginAdd(request({ method: "GET", query: {} }), missing as unknown as NextApiResponse);
    expect(missing.status).toHaveBeenCalledWith(400);
    expect(missing.json).toHaveBeenCalledWith({ message: "Zoho Bigin client_id missing." });

    const wrongMethod = response();
    await biginAdd(request({ method: "POST", query: {} }), wrongMethod as unknown as NextApiResponse);
    expect(wrongMethod.status).toHaveBeenCalledWith(400);
    expect(wrongMethod.json).toHaveBeenCalledWith({ message: "Invalid request method." });
  });

  it("exchanges the code, stores the regional token and redirects", async () => {
    handleRequest = () => ({
      data: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        api_domain: API_DOMAIN,
        token_type: "Bearer",
      },
    });
    const res = response();
    const startedAt = Date.now();

    await biginCallback(
      request({
        method: "GET",
        query: { code: "auth-code", "accounts-server": ACCOUNTS_SERVER },
        session: { user: { id: 1 } },
      }),
      res as unknown as NextApiResponse
    );

    expect(requests[0].url).toBe(`${ACCOUNTS_SERVER}/oauth/v2/token`);
    expect(Object.fromEntries(new URLSearchParams(String(requests[0].data)))).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "auth-code",
      redirect_uri: `${WEBAPP_URL}/api/integrations/zoho-bigin/callback`,
      grant_type: "authorization_code",
    });
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({ type: "zoho-bigin_crm", appId: "zoho-bigin", userId: 1 });
    expect(stored.data.key).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      accountServer: ACCOUNTS_SERVER,
    });
    // Baseline treats expires_in as milliseconds, so the token refreshes on the next request.
    expect(stored.data.key.expiryDate).toBeGreaterThanOrEqual(startedAt + 3600);
    expect(stored.data.key.expiryDate).toBeLessThanOrEqual(Date.now() + 3600);
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/crm?hl=zoho-bigin");
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("new-access");
  });

  it("rejects an unapproved accounts server and a missing session without exchanging", async () => {
    const unapproved = response();
    await biginCallback(
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
    await biginCallback(
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
      biginCallback(
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

describe("Zoho Bigin contacts", () => {
  it("searches in the stored api domain and creates contacts", async () => {
    handleRequest = () => ({ data: { data: [{ id: "contact-1", Email: "alex@example.com" }] } });
    const contacts = await BuildCrmService(credential()).getContacts({ emails: ["alex@example.com"] });

    expect(contacts).toEqual(CONTACTS);
    expect(requests[0].url).toBe(
      `${API_DOMAIN}/bigin/v1/Contacts/search?criteria=((Email:equals:alex@example.com))`
    );
    expect(requests[0].headers.get("authorization")).toBe("Zoho-oauthtoken access-token");

    handleRequest = () => ({
      data: {
        data: [{ code: "SUCCESS", details: { id: "contact-1" }, message: "record added", status: "success" }],
      },
    });
    const created = await BuildCrmService(credential()).createContacts([
      { name: "Alex Doe", email: "alex@example.com" },
    ]);

    // The create response only carries the record id under details.id.
    expect(created.map(({ id }) => id)).toEqual(["contact-1"]);
    expect(requests[1].url).toBe(`${API_DOMAIN}/bigin/v1/Contacts`);
    expect(JSON.parse(String(requests[1].data))).toEqual({
      data: [{ First_Name: "Alex", Last_Name: "Doe", Email: "alex@example.com" }],
    });
  });

  it("propagates a failed contact search", async () => {
    handleRequest = () => {
      throw new Error("bigin unavailable");
    };

    await expect(BuildCrmService(credential()).getContacts({ emails: "alex@example.com" })).rejects.toThrow(
      "bigin unavailable"
    );
  });
});

describe("Zoho Bigin events", () => {
  it("creates, updates and deletes the booking event", async () => {
    handleRequest = () => ({
      data: { data: [{ status: "success", details: { id: "event-1" } }] },
    });
    const created = await BuildCrmService(credential()).createEvent(event(), CONTACTS);

    expect(created).toMatchObject({
      uid: "event-1",
      id: "event-1",
      type: "zoho-bigin",
      externalCalendarId: "NO_CALENDAR_ID_NEEDED",
    });
    expect(requests[0].url).toBe(`${API_DOMAIN}/bigin/v1/Events`);
    expect(JSON.parse(String(requests[0].data))).toEqual({
      data: [
        {
          Event_Title: "Planning",
          Start_DateTime: "2024-01-15T09:00:00+00:00",
          End_DateTime: "2024-01-15T10:00:00+00:00",
          Description: "Bring the deck",
          Venue: "https://meet.example.com/planning",
          Who_Id: "contact-1",
        },
      ],
    });

    await BuildCrmService(credential()).updateEvent("event-1", event({ title: "Moved" }));
    expect(requests[1].url).toBe(`${API_DOMAIN}/bigin/v1/Events`);
    expect(requests[1].method).toBe("put");
    expect(JSON.parse(String(requests[1].data))).toMatchObject({
      data: [{ id: "event-1", Event_Title: "Moved", Location: "https://meet.example.com/planning" }],
    });

    await BuildCrmService(credential()).deleteEvent("event-1");
    expect(requests[2].url).toBe(`${API_DOMAIN}/bigin/v1/Events?ids=event-1`);
    expect(requests[2].method).toBe("delete");
  });

  it("rejects an unconfirmed event and swallows update failures", async () => {
    handleRequest = () => ({ data: { data: [{ status: "error", code: "INVALID_DATA" }] } });

    await expect(BuildCrmService(credential()).createEvent(event(), CONTACTS)).rejects.toBe(
      "Something went wrong when creating a meeting in Zoho Bigin"
    );

    handleRequest = () => {
      throw new Error("bigin update failed");
    };
    await expect(BuildCrmService(credential()).updateEvent("event-1", event())).resolves.toBeUndefined();
  });
});

describe("Zoho Bigin token lifecycle", () => {
  it("refreshes an expired token against the stored accounts server and persists it", async () => {
    handleRequest = (config) =>
      config.url === `${ACCOUNTS_SERVER}/oauth/v2/token`
        ? { data: { access_token: "refreshed-access", expires_in: 3600 } }
        : { data: { data: [{ id: "contact-1", Email: "alex@example.com" }] } };

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
