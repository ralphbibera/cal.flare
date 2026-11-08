import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import "vitest-fetch-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import addPipedrive from "../api/add";
import pipedriveCallback from "../api/callback";
import BuildCrmService from "../lib/CrmService";

const CLIENT_ID = "pipedrive-client";
const CLIENT_SECRET = "pipedrive-secret";
const API_DOMAIN = "https://acme.pipedrive.com";
const CREDENTIAL_ID = 42;
const CALLBACK_URL = "http://localhost:3000/api/integrations/pipedrive-crm/callback";

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
  const log: Record<string, unknown> = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  log.getSubLogger = () => log;
  return { default: { ...log, getSubLogger: () => log } };
});

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
      expires_in: 3600,
      api_domain: API_DOMAIN,
      expiry_date: expiry,
      expiryDate: expiry,
    },
  }) as CredentialPayload;

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
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
const MAPPED = { id: "7", email: "alex@example.com", firstName: "Alex", lastName: "Doe", name: "Alex Doe" };
const CONTACTS = [{ id: "7", email: "alex@example.com" }];

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

describe("Pipedrive install and OAuth", () => {
  it("creates the install and returns a consent URL without secrets", async () => {
    const res = response();

    await addPipedrive(request({ method: "GET", query: {} }), res as unknown as NextApiResponse);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "pipedrive-crm_other_calendar",
        key: {},
        userId: 1,
        appId: "pipedrive-crm",
      }),
    });
    const payload = res.json.mock.calls[0][0] as { url: string; newTab: boolean };
    const url = new URL(payload.url);
    expect(url.origin).toBe("https://oauth.pipedrive.com");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(url.searchParams.get("scope")).toContain("activities:write");
    expect(payload).not.toHaveProperty("key");
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
  });

  it("rejects a missing client id and an anonymous install", async () => {
    prisma.app.findUnique.mockResolvedValue({ keys: {} });
    const missing = response();
    await addPipedrive(request({ method: "GET", query: {} }), missing as unknown as NextApiResponse);
    expect(missing.status).toHaveBeenCalledWith(400);
    expect(prisma.credential.create).not.toHaveBeenCalled();

    prisma.app.findUnique.mockResolvedValue({
      keys: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    });
    getServerSessionMock.mockResolvedValue(null);
    await expect(
      addPipedrive(request({ method: "GET", query: {} }), response() as unknown as NextApiResponse)
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("exchanges the code, stores the token and redirects without leaking it", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        api_domain: API_DOMAIN,
      })
    );
    const res = response();

    await pipedriveCallback(
      request({ query: { code: "auth-code" }, session: { user: { id: 1 } } }),
      res as unknown as NextApiResponse
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth.pipedrive.com/oauth/token");
    expect(String(init?.body)).toContain("grant_type=authorization_code");
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    });
    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({ type: "pipedrive-crm_crm", appId: "pipedrive-crm" });
    expect(stored.data.key).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      api_domain: API_DOMAIN,
    });
    expect(stored.data.key.expiryDate).toBeGreaterThan(Date.now());
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/crm?hl=pipedrive-crm");
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("new-access");
  });

  it("does not store a credential when the exchange fails", async () => {
    fetchMock.mockResponseOnce("invalid_grant", { status: 400 });
    const res = response();

    await pipedriveCallback(
      request({ query: { code: "expired" }, session: { user: { id: 1 } } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: "Failed to exchange OAuth code",
      detail: "invalid_grant",
    });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Pipedrive contacts and activities", () => {
  it("looks up and creates contacts", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { items: [{ item: CONTACT }] } }));
    const service = BuildCrmService(credential());

    expect(await service.getContacts({ emails: "alex@example.com" })).toEqual([MAPPED]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API_DOMAIN}/api/v1/persons/search?term=alex%40example.com&fields=email`
    );

    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: CONTACT }));
    expect(await service.createContacts([{ name: "Alex Doe", email: "alex@example.com" }])).toEqual([MAPPED]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      first_name: "Alex",
      last_name: "Doe",
      email: [{ value: "alex@example.com", primary: true }],
    });
  });

  it("swallows lookup failures but rejects a failed creation", async () => {
    fetchMock.mockRejectOnce(new Error("pipedrive offline"));
    await expect(BuildCrmService(credential()).getContacts({ emails: "alex@example.com" })).resolves.toEqual(
      []
    );

    fetchMock.mockResponseOnce(JSON.stringify({ success: false }));
    await expect(
      BuildCrmService(credential()).createContacts([{ name: "Alex", email: "alex@example.com" }])
    ).rejects.toThrow("Failed to create contact");
  });

  it("creates, updates and deletes the booking activity", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { id: 99 } }));
    expect(await BuildCrmService(credential()).createEvent(event(), CONTACTS)).toMatchObject({
      uid: "99",
      type: "pipedrive-crm",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      subject: "Planning",
      due_date: "2024-01-15",
      due_time: "09:00",
      duration: "1:00",
      person_id: 7,
    });
    expect(String(body.note)).toContain("Bring the deck");

    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { id: 99 } }));
    await BuildCrmService(credential()).updateEvent("99", event({ title: "Moved" }));
    expect(fetchMock.mock.calls[1][0]).toBe(`${API_DOMAIN}/api/v1/activities/99`);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PUT");

    fetchMock.mockResponseOnce(JSON.stringify({ success: true }));
    await BuildCrmService(credential()).deleteEvent("99");
    expect(fetchMock.mock.calls[2][1]?.method).toBe("DELETE");
  });

  it("rejects an unconfirmed activity", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ success: false }));
    await expect(BuildCrmService(credential()).createEvent(event(), CONTACTS)).rejects.toBe(
      "Something went wrong when creating a meeting in PipedriveCRM"
    );
  });
});

describe("Pipedrive token lifecycle", () => {
  it("refreshes an expired token, stores it and uses it", async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        expires_in: 3600,
        api_domain: API_DOMAIN,
      })
    );
    fetchMock.mockResponseOnce(JSON.stringify({ success: true, data: { items: [{ item: CONTACT }] } }));

    await BuildCrmService(credential(Date.now() - 1000)).getContacts({ emails: "alex@example.com" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://oauth.pipedrive.com/oauth/token");
    expect(String(fetchMock.mock.calls[0][1]?.body)).toBe(
      "grant_type=refresh_token&refresh_token=refresh-token"
    );
    expect(credentialRepository.updateWhereId).toHaveBeenCalledWith({
      id: CREDENTIAL_ID,
      data: { key: expect.objectContaining({ access_token: "refreshed-access" }) },
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer refreshed-access",
    });
  });

  it("invalidates a rejected refresh token and expires the key after a 401", async () => {
    fetchMock.mockResponseOnce(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    await expect(
      BuildCrmService(credential(Date.now() - 1000)).getContacts({ emails: "alex@example.com" })
    ).resolves.toEqual([]);
    expect(prisma.credential.update).toHaveBeenCalledWith({
      where: { id: CREDENTIAL_ID },
      data: { invalid: true },
    });

    fetchMock.mockResponseOnce(JSON.stringify({ error: "invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    await BuildCrmService(credential()).getContacts({ emails: "alex@example.com" });
    const expired = prisma.credential.update.mock.calls[1][0] as {
      data: { key: { expiry_date: number } };
    };
    expect(expired.data.key.expiry_date).toBeLessThan(Date.now());
  });
});
