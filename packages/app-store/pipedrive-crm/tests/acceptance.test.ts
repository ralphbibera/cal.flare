import type { NextApiRequest, NextApiResponse } from "next";
import "vitest-fetch-mock";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import { beforeEach, describe, expect, it, vi } from "vitest";
import addPipedrive from "../api/add";
import pipedriveCallback from "../api/callback";
import BuildCrmService from "../lib/CrmService";

const CLIENT_ID = "pipedrive-client";
const CLIENT_SECRET = "pipedrive-secret";
const API_DOMAIN = "https://acme.pipedrive.com";
const CREDENTIAL_ID = 42;

const { prisma, credentialRepository, getServerSessionMock } = vi.hoisted(() => ({
  prisma: {
    app: { findUnique: vi.fn() },
    credential: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  credentialRepository: { updateWhereId: vi.fn() },
  getServerSessionMock: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: { updateWhereId: credentialRepository.updateWhereId },
}));
vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: getServerSessionMock,
}));
vi.mock("@calcom/lib/logger", () => {
  const subLogger: Record<string, unknown> = {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
  subLogger.getSubLogger = () => subLogger;
  return { default: { ...subLogger, getSubLogger: () => subLogger } };
});

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

const createResponse = () => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};

const request = (overrides: Record<string, unknown>) => overrides as unknown as NextApiRequest;

const buildCredential = (overrides: Partial<CredentialPayload["key"] & { expiryDate: number }> = {}) =>
  ({
    id: CREDENTIAL_ID,
    type: "pipedrive-crm_crm",
    appId: "pipedrive-crm",
    userId: 1,
    teamId: null,
    invalid: false,
    delegationCredentialId: null,
    encryptedKey: null,
    user: { email: "jane@example.com" },
    key: {
      access_token: "access-token",
      token_type: "Bearer",
      refresh_token: "refresh-token",
      scope: "deals:read,persons:read,activities:read",
      expires_in: 3600,
      api_domain: API_DOMAIN,
      expiry_date: Date.now() + 3600_000,
      expiryDate: Date.now() + 3600_000,
      ...overrides,
    },
  }) as CredentialPayload;

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({
    type: "pipedrive-crm_crm",
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

const CONTACT = {
  id: 7,
  name: "Alex Doe",
  first_name: "Alex",
  last_name: "Doe",
  email: [{ value: "alex@example.com", primary: true }],
};

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.resetMocks();
  prisma.app.findUnique.mockResolvedValue({
    keys: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
  });
  prisma.credential.create.mockResolvedValue({ id: CREDENTIAL_ID, key: {} });
  prisma.credential.findUnique.mockResolvedValue({ id: CREDENTIAL_ID });
  prisma.credential.update.mockResolvedValue({});
  credentialRepository.updateWhereId.mockResolvedValue({});
  getServerSessionMock.mockResolvedValue({ user: { id: 1, email: "jane@example.com" } });
});

describe("Pipedrive install", () => {
  it("creates the installation and returns the OAuth URL without app keys", async () => {
    const res = createResponse();

    await addPipedrive(request({ method: "GET", query: {} }), res as unknown as NextApiResponse);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "pipedrive-crm_other_calendar",
        key: {},
        userId: 1,
        appId: "pipedrive-crm",
      }),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0] as { url: string; newTab: boolean };
    const url = new URL(payload.url);
    expect(url.origin).toBe("https://oauth.pipedrive.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/integrations/pipedrive-crm/callback"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      "deals:read,deals:write,persons:read,persons:write,activities:read,activities:write"
    );
    expect(payload.newTab).toBe(true);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("rejects the add when the app client id is not configured", async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    const res = createResponse();

    await addPipedrive(request({ method: "GET", query: {} }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Pipedrive client id missing." });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("requires a session before installing", async () => {
    getServerSessionMock.mockResolvedValue(null);

    await expect(
      addPipedrive(request({ method: "GET", query: {} }), createResponse() as unknown as NextApiResponse)
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Pipedrive OAuth callback", () => {
  it("exchanges the code and stores the token object with an expiry date", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "new-access",
        token_type: "Bearer",
        refresh_token: "new-refresh",
        scope: "deals:read",
        expires_in: 3600,
        api_domain: API_DOMAIN,
      })
    );
    const res = createResponse();

    await pipedriveCallback(
      request({ query: { code: "auth-code" }, session: { user: { id: 1 } } }),
      res as unknown as NextApiResponse
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth.pipedrive.com/oauth/token");
    // Workers: Basic auth uses Buffer, supplied by the nodejs_compat flag (apps/web/cloudflare.config.ts:15).
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(String(init?.body)).toBe(
      `grant_type=authorization_code&code=auth-code&redirect_uri=${encodeURIComponent(
        "http://localhost:3000/api/integrations/pipedrive-crm/callback"
      )}`
    );
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; appId: string; key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({
      type: "pipedrive-crm_crm",
      appId: "pipedrive-crm",
      userId: 1,
    });
    expect(stored.data.key).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      api_domain: API_DOMAIN,
    });
    expect(stored.data.key.expiryDate).toBeGreaterThan(Date.now());
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/crm?hl=pipedrive-crm");
  });

  it("reports a failed code exchange without creating a credential", async () => {
    fetchMock.mockResponseOnce("invalid_grant", { status: 400 });
    const res = createResponse();

    await pipedriveCallback(
      request({ query: { code: "expired-code" }, session: { user: { id: 1 } } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: "Failed to exchange OAuth code",
      detail: "invalid_grant",
    });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a repeated code parameter and an anonymous callback", async () => {
    const repeated = createResponse();
    await pipedriveCallback(
      request({ query: { code: ["one", "two"] }, session: { user: { id: 1 } } }),
      repeated as unknown as NextApiResponse
    );
    expect(repeated.status).toHaveBeenCalledWith(400);
    expect(repeated.json).toHaveBeenCalledWith({ message: "`code` must be a string" });

    const anonymous = createResponse();
    await pipedriveCallback(
      request({ query: { code: "auth-code" } }),
      anonymous as unknown as NextApiResponse
    );
    expect(anonymous.status).toHaveBeenCalledWith(401);
    expect(anonymous.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
  });
});

describe("Pipedrive contacts", () => {
  it("looks contacts up by email in the stored api domain", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { items: [{ item: CONTACT }] } }));

    const contacts = await BuildCrmService(buildCredential()).getContacts({
      emails: "alex@example.com",
    });

    expect(contacts).toEqual([
      {
        id: "7",
        email: "alex@example.com",
        firstName: "Alex",
        lastName: "Doe",
        name: "Alex Doe",
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_DOMAIN}/api/v1/persons/search?term=alex%40example.com&fields=email`);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer access-token" });
  });

  it("creates a person from the attendee name", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: CONTACT }));

    const contacts = await BuildCrmService(buildCredential()).createContacts([
      { name: "Alex Doe", email: "alex@example.com" },
    ]);

    expect(contacts).toEqual([
      {
        id: "7",
        email: "alex@example.com",
        firstName: "Alex",
        lastName: "Doe",
        name: "Alex Doe",
      },
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Alex Doe",
      first_name: "Alex",
      last_name: "Doe",
      email: [{ value: "alex@example.com", primary: true }],
    });
  });

  it("swallows lookup failures but rejects a failed person creation", async () => {
    fetchMock.mockRejectOnce(new Error("pipedrive offline"));
    await expect(
      BuildCrmService(buildCredential()).getContacts({ emails: "alex@example.com" })
    ).resolves.toEqual([]);

    fetchMock.mockResponseOnce(JSON.stringify({ success: false }));
    await expect(
      BuildCrmService(buildCredential()).createContacts([{ name: "Alex Doe", email: "alex@example.com" }])
    ).rejects.toThrow("Failed to create contact");
  });
});

describe("Pipedrive activities", () => {
  const contacts = [{ id: "7", email: "alex@example.com" }];

  it("creates an activity linked to the first contact", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { id: 99, subject: "Planning" } }));

    const result = await BuildCrmService(buildCredential()).createEvent(buildEvent(), contacts);

    expect(result).toMatchObject({ uid: "99", id: "99", type: "pipedrive-crm" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_DOMAIN}/api/v1/activities`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      subject: "Planning",
      type: "meeting",
      due_date: "2024-01-15",
      due_time: "09:00",
      duration: "1:00",
      note: "invitee_timezone: Europe/London\n\nshare_additional_notes\nBring the deck",
      location: "https://meet.example.com/planning",
      person_id: 7,
    });
  });

  it("updates and deletes the activity through its uid", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { id: 99 } }));
    await BuildCrmService(buildCredential()).updateEvent("99", buildEvent({ title: "Moved" }));
    const [updateUrl, updateInit] = fetchMock.mock.calls[0];
    expect(updateUrl).toBe(`${API_DOMAIN}/api/v1/activities/99`);
    expect(updateInit?.method).toBe("PUT");
    expect(JSON.parse(String(updateInit?.body))).toMatchObject({
      subject: "Moved",
      duration: "1:00",
    });

    fetchMock.mockResponseOnce(JSON.stringify({ success: true }));
    await BuildCrmService(buildCredential()).deleteEvent("99");
    expect(fetchMock.mock.calls[1][0]).toBe(`${API_DOMAIN}/api/v1/activities/99`);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("rejects when Pipedrive does not confirm the activity", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: false }));

    await expect(BuildCrmService(buildCredential()).createEvent(buildEvent(), contacts)).rejects.toBe(
      "Something went wrong when creating a meeting in PipedriveCRM"
    );
  });
});

describe("Pipedrive token lifecycle", () => {
  it("refreshes an expired token and stores the replacement", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "refreshed-access",
        token_type: "Bearer",
        refresh_token: "refreshed-refresh",
        expires_in: 3600,
        api_domain: API_DOMAIN,
      })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { items: [{ item: CONTACT }] } }));

    await BuildCrmService(
      buildCredential({ expiry_date: Date.now() - 1000, expiryDate: Date.now() - 1000 })
    ).getContacts({
      emails: "alex@example.com",
    });

    const [refreshUrl, refreshInit] = fetchMock.mock.calls[0];
    expect(refreshUrl).toBe("https://oauth.pipedrive.com/oauth/token");
    expect(refreshInit?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    });
    expect(String(refreshInit?.body)).toBe("grant_type=refresh_token&refresh_token=refresh-token");
    expect(credentialRepository.updateWhereId).toHaveBeenCalledWith({
      id: CREDENTIAL_ID,
      data: { key: expect.objectContaining({ access_token: "refreshed-access" }) },
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer refreshed-access",
    });
  });

  it("invalidates the credential when the refresh token is rejected", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

    await expect(
      BuildCrmService(
        buildCredential({ expiry_date: Date.now() - 1000, expiryDate: Date.now() - 1000 })
      ).getContacts({
        emails: "alex@example.com",
      })
    ).resolves.toEqual([]);
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: CREDENTIAL_ID },
      data: { invalid: true },
    });
  });

  it("expires the access token after a 401 and keeps the existing body", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ error: "invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

    await BuildCrmService(buildCredential()).getContacts({ emails: "alex@example.com" });

    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: CREDENTIAL_ID },
      data: {
        key: expect.objectContaining({ expiry_date: expect.any(Number) }),
      },
    });
    const expired = prisma.credential.update.mock.calls[0][0].data.key as { expiry_date: number };
    expect(expired.expiry_date).toBeLessThan(Date.now());
  });
});
