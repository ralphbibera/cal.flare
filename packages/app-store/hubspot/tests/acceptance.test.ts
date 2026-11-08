import { createHmac } from "node:crypto";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { TFunction } from "i18next";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventTypeAppMetadataSchema } from "../../zod-utils";
import addHubspot from "../api/add";
import hubspotCallback from "../api/callback";
import BuildCrmService from "../lib/CrmService";
import { CrmFieldType, DateFieldType, WhenToWrite } from "../zod";

const APP_URL = "http://app.cal.local:3000";
const OAUTH_URL = "http://localhost:3000";
const STATE_SECRET = "hubspot-oauth-state-secret";
const MEETING_ID = "meeting-1";
const CONTACT_ID = "contact-1";

const mocks = vi.hoisted(() => ({
  getAppKeysFromSlug: vi.fn(),
  createOAuthAppCredential: vi.fn(),
  credentialUpdate: vi.fn(),
  client: {
    crm: {
      properties: { coreApi: { getAll: vi.fn() } },
      contacts: {
        searchApi: { doSearch: vi.fn() },
        basicApi: { create: vi.fn(), getById: vi.fn(), update: vi.fn() },
      },
      objects: {
        meetings: { basicApi: { create: vi.fn(), update: vi.fn(), archive: vi.fn() } },
      },
      associations: { batchApi: { create: vi.fn() } },
      owners: { ownersApi: { getPage: vi.fn(), getById: vi.fn() } },
    },
    oauth: {
      getAuthorizationUrl: vi.fn(),
      tokensApi: { createToken: vi.fn() },
    },
    setAccessToken: vi.fn(),
  },
}));

vi.mock("@hubspot/api-client", () => ({
  Client: class {
    crm = mocks.client.crm;
    oauth = mocks.client.oauth;
    setAccessToken = mocks.client.setAccessToken;
  },
}));

vi.mock("../../_utils/getAppKeysFromSlug", () => ({ default: mocks.getAppKeysFromSlug }));

vi.mock("../../_utils/oauth/createOAuthAppCredential", () => ({
  default: mocks.createOAuthAppCredential,
}));

vi.mock("@calcom/prisma", () => ({
  default: { credential: { update: mocks.credentialUpdate } },
}));

vi.mock("@calcom/features/bookings/repositories/BookingRepository", () => ({
  BookingRepository: class {},
}));

vi.mock("@calcom/features/bookings/repositories/PrismaTrackingRepository", () => ({
  PrismaTrackingRepository: class {},
}));

vi.mock("@calcom/features/watchlist/lib/freeEmailDomainCheck/checkIfFreeEmailDomain", () => ({
  checkIfFreeEmailDomain: vi.fn().mockResolvedValue(false),
}));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = { status: vi.fn(), json: vi.fn(), redirect: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const createRequest = ({ query = {}, userId }: { query?: Record<string, unknown>; userId?: number }) =>
  ({
    method: "GET",
    query,
    session: userId ? { user: { id: userId } } : undefined,
  }) as unknown as NextApiRequest;

const stateFor = (userId: number, returnTo: string) => {
  const nonce = "test-nonce";
  return JSON.stringify({
    returnTo,
    nonce,
    nonceHash: createHmac("sha256", STATE_SECRET).update(`${nonce}:${userId}`).digest("hex"),
  });
};

const appKeys = {
  client_id: "hubspot-client-id",
  client_secret: "hubspot-client-secret",
};

const buildCredential = (expiryDate = Date.now() + 3600 * 1000): CredentialPayload => ({
  id: 1,
  type: "hubspot_other_calendar",
  key: {
    accessToken: "stored-access-token",
    refreshToken: "stored-refresh-token",
    expiryDate,
    tokenType: "Bearer",
  },
  userId: 1,
  appId: "hubspot",
  teamId: null,
  invalid: false,
  user: { email: "owner@example.com" },
  delegationCredentialId: null,
  encryptedKey: null,
});

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "hubspot_crm",
  title: "Planning",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  uid: "booking-1",
  responses: {
    name: { label: "Name", value: "Jane Doe" },
    email: { label: "Email", value: "jane@example.com" },
  },
  customInputs: {},
  organizer: {
    name: "Owner",
    email: "owner@example.com",
    timeZone: "Europe/London",
    language: { translate: ((key: string) => key) as TFunction, locale: "en" },
  },
  attendees: [
    {
      name: "Jane Doe",
      email: "jane@example.com",
      timeZone: "Europe/London",
      language: { translate: ((key: string) => key) as TFunction, locale: "en" },
    },
  ],
  ...overrides,
});

const setupMeetingMocks = () => {
  mocks.client.crm.owners.ownersApi.getPage.mockResolvedValue({ results: [] });
  mocks.client.crm.objects.meetings.basicApi.create.mockResolvedValue({
    id: MEETING_ID,
    properties: {},
  });
  mocks.client.crm.associations.batchApi.create.mockResolvedValue({ results: [] });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
  vi.stubEnv("NEXTAUTH_SECRET", STATE_SECRET);
  mocks.getAppKeysFromSlug.mockReset().mockResolvedValue(appKeys);
  mocks.createOAuthAppCredential.mockReset().mockResolvedValue(undefined);
  mocks.credentialUpdate.mockReset().mockResolvedValue(undefined);
  mocks.client.oauth.getAuthorizationUrl
    .mockReset()
    .mockReturnValue("https://app.hubspot.com/oauth/authorize?client_id=hubspot-client-id");
  mocks.client.oauth.tokensApi.createToken.mockReset();
  mocks.client.setAccessToken.mockReset();
  for (const fn of [
    mocks.client.crm.properties.coreApi.getAll,
    mocks.client.crm.contacts.searchApi.doSearch,
    mocks.client.crm.contacts.basicApi.create,
    mocks.client.crm.contacts.basicApi.getById,
    mocks.client.crm.contacts.basicApi.update,
    mocks.client.crm.objects.meetings.basicApi.create,
    mocks.client.crm.objects.meetings.basicApi.update,
    mocks.client.crm.objects.meetings.basicApi.archive,
    mocks.client.crm.associations.batchApi.create,
    mocks.client.crm.owners.ownersApi.getPage,
    mocks.client.crm.owners.ownersApi.getById,
  ]) {
    fn.mockReset();
  }
  fetchMock.resetMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HubSpot OAuth add", () => {
  it("builds the consent URL with the configured client and a signed state", async () => {
    const returnTo = `${APP_URL}/apps/installed/other?hl=hubspot`;
    const req = createRequest({ query: { state: JSON.stringify({ returnTo }) }, userId: 1 });
    const res = createResponse();

    await addHubspot(req, res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      url: "https://app.hubspot.com/oauth/authorize?client_id=hubspot-client-id",
    });
    const args = mocks.client.oauth.getAuthorizationUrl.mock.calls[0];
    expect(args[0]).toBe("hubspot-client-id");
    expect(args[1]).toBe(`${OAUTH_URL}/api/integrations/hubspot/callback`);
    expect(args[2]).toBe("crm.objects.contacts.read crm.objects.contacts.write crm.objects.owners.read");
    expect(args[3]).toBeUndefined();
    const state = JSON.parse(args[4]);
    expect(state.returnTo).toBe(returnTo);
    expect(state.nonceHash).toBe(createHmac("sha256", STATE_SECRET).update(`${state.nonce}:1`).digest("hex"));
  });
});

describe("HubSpot OAuth callback", () => {
  it("exchanges the code, stores the expiring token, and redirects", async () => {
    const returnTo = `${APP_URL}/apps/installed/other?hl=hubspot`;
    mocks.client.oauth.tokensApi.createToken.mockResolvedValue({
      accessToken: "hubspot-access-token",
      refreshToken: "hubspot-refresh-token",
      expiresIn: 1800,
      tokenType: "Bearer",
    });
    const res = createResponse();

    await hubspotCallback(
      createRequest({ query: { code: "auth-code", state: stateFor(1, returnTo) }, userId: 1 }),
      res as unknown as NextApiResponse
    );

    expect(mocks.client.oauth.tokensApi.createToken).toHaveBeenCalledWith(
      "authorization_code",
      "auth-code",
      `${OAUTH_URL}/api/integrations/hubspot/callback`,
      "hubspot-client-id",
      "hubspot-client-secret"
    );
    expect(mocks.createOAuthAppCredential).toHaveBeenCalledWith(
      { appId: "hubspot", type: "hubspot_crm" },
      expect.objectContaining({
        accessToken: "hubspot-access-token",
        refreshToken: "hubspot-refresh-token",
        expiryDate: Date.now() + 1800 * 1000,
      }),
      expect.anything()
    );
    expect(res.redirect).toHaveBeenCalledWith(returnTo);
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("hubspot-access-token");
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("hubspot-refresh-token");
  });

  it("does not store a credential when the token exchange fails", async () => {
    mocks.client.oauth.tokensApi.createToken.mockRejectedValue(new Error("invalid_grant"));
    const res = createResponse();

    await expect(
      hubspotCallback(
        createRequest({ query: { code: "auth-code", state: stateFor(1, APP_URL) }, userId: 1 }),
        res as unknown as NextApiResponse
      )
    ).rejects.toThrow("invalid_grant");
    expect(mocks.createOAuthAppCredential).not.toHaveBeenCalled();
  });
});

describe("HubSpot token refresh", () => {
  it("refreshes an expired token, persists the new key, and applies it to the client", async () => {
    mocks.client.oauth.tokensApi.createToken.mockResolvedValue({
      accessToken: "refreshed-access-token",
      refreshToken: "stored-refresh-token",
      expiresIn: 3600,
      tokenType: "Bearer",
    });
    setupMeetingMocks();
    const service = BuildCrmService(buildCredential(Date.now() - 1000), {});

    await service.createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }]);

    expect(mocks.client.oauth.tokensApi.createToken).toHaveBeenCalledWith(
      "refresh_token",
      undefined,
      `${APP_URL}/api/integrations/hubspot/callback`,
      "hubspot-client-id",
      "hubspot-client-secret",
      "stored-refresh-token"
    );
    expect(mocks.credentialUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        key: expect.objectContaining({
          accessToken: "refreshed-access-token",
          expiryDate: Date.now() + 3600 * 1000,
        }),
      },
    });
    expect(mocks.client.setAccessToken).toHaveBeenCalledWith("refreshed-access-token");
    expect(mocks.client.crm.objects.meetings.basicApi.create).toHaveBeenCalled();
  });

  it("reuses a valid token without calling the refresh endpoint", async () => {
    setupMeetingMocks();
    const service = BuildCrmService(buildCredential(), {});

    await service.createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }]);

    expect(mocks.client.oauth.tokensApi.createToken).not.toHaveBeenCalled();
    expect(mocks.client.setAccessToken).toHaveBeenCalledWith("stored-access-token");
    expect(mocks.credentialUpdate).not.toHaveBeenCalled();
  });

  it("continues meeting creation when the refresh call fails", async () => {
    mocks.client.oauth.tokensApi.createToken.mockRejectedValue(new Error("refresh_failed"));
    setupMeetingMocks();
    const service = BuildCrmService(buildCredential(Date.now() - 1000), {});

    const result = await service.createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }]);

    expect(result).toMatchObject({ uid: MEETING_ID, type: "hubspot_other_calendar" });
    expect(mocks.credentialUpdate).not.toHaveBeenCalled();
  });
});

describe("HubSpot contacts", () => {
  it("creates a contact with the attendee phone number", async () => {
    mocks.client.crm.contacts.basicApi.create.mockResolvedValue({
      id: CONTACT_ID,
      properties: { email: "jane@example.com" },
    });
    const service = BuildCrmService(buildCredential(), {});

    const result = await service.createContacts([
      { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567" },
    ]);

    expect(mocks.client.crm.contacts.basicApi.create).toHaveBeenCalledWith({
      properties: {
        firstname: "Jane",
        lastname: "Doe",
        email: "jane@example.com",
        phone: "+15551234567",
      },
    });
    expect(result).toEqual([{ id: CONTACT_ID, email: "jane@example.com" }]);
  });

  it("propagates contact search failures", async () => {
    mocks.client.crm.contacts.searchApi.doSearch.mockRejectedValue(new Error("search_unavailable"));
    const service = BuildCrmService(buildCredential(), {});

    await expect(service.getContacts({ emails: "jane@example.com" })).rejects.toThrow("search_unavailable");
  });
});

describe("HubSpot booking meetings", () => {
  it("maps event-type field settings onto the meeting and associates attendees", async () => {
    const appOptions = EventTypeAppMetadataSchema.parse({
      hubspot: {
        onBookingWriteToEventObject: true,
        onBookingWriteToEventObjectFields: {
          cal_source: {
            fieldType: CrmFieldType.TEXT,
            value: "{name}",
            whenToWrite: WhenToWrite.EVERY_BOOKING,
          },
          cal_start: {
            fieldType: CrmFieldType.DATE,
            value: DateFieldType.BOOKING_START_DATE,
            whenToWrite: WhenToWrite.EVERY_BOOKING,
          },
        },
      },
    }).hubspot;
    if (!appOptions) throw new Error("hubspot app options were not parsed");
    mocks.client.crm.properties.coreApi.getAll.mockResolvedValue({
      results: [
        { name: "cal_source", type: "string" },
        { name: "cal_start", type: "datetime" },
      ],
    });
    setupMeetingMocks();
    const service = BuildCrmService(buildCredential(), appOptions);

    await service.createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }]);

    expect(mocks.client.crm.objects.meetings.basicApi.create).toHaveBeenCalledWith({
      properties: expect.objectContaining({
        hs_meeting_title: "Planning",
        hs_meeting_outcome: "SCHEDULED",
        cal_source: "Jane Doe",
        cal_start: "2024-01-15T09:00:00.000Z",
      }),
    });
    expect(mocks.client.crm.associations.batchApi.create).toHaveBeenCalledWith("meetings", "contacts", {
      inputs: [
        {
          _from: { id: MEETING_ID },
          to: { id: CONTACT_ID },
          type: "meeting_event_to_contact",
        },
      ],
    });
  });

  it("rejects when the meeting cannot be associated with its attendees", async () => {
    setupMeetingMocks();
    mocks.client.crm.associations.batchApi.create.mockResolvedValue(undefined);
    const service = BuildCrmService(buildCredential(), {});

    await expect(
      service.createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }])
    ).rejects.toBe("Something went wrong when associating the meeting and attendees in HubSpot");
  });
});
