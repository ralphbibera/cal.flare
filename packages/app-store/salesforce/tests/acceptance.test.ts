import { createHmac } from "node:crypto";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { TFunction } from "i18next";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventTypeAppMetadataSchema } from "../../zod-utils";
import addSalesforce from "../api/add";
import salesforceCallback from "../api/callback";
import { createSalesforceCrmServiceWithSalesforceType } from "../lib/CrmService";
import { SalesforceFieldType, WhenToWriteToRecord } from "../lib/enums";

const APP_URL = "http://app.cal.local:3000";
const OAUTH_URL = "http://localhost:3000";
const STATE_SECRET = "salesforce-oauth-state-secret";
const CONTACT_ID = "003000000000001";
const LEAD_ID = "00Q000000000001";
const EVENT_ID = "00U000000000001";
const ORGANIZER_ID = "005000000000001";
const language = { translate: ((key: string) => key) as TFunction, locale: "en" };

const mocks = vi.hoisted(() => ({
  getAppKeysFromSlug: vi.fn(),
  createOAuthAppCredential: vi.fn(),
  updateCredentialKey: vi.fn(),
  connectionOptions: [] as Record<string, unknown>[],
  connection: {
    query: vi.fn(),
    search: vi.fn(),
    sobject: vi.fn(),
    describe: vi.fn(),
    oauth2: { requestToken: vi.fn(), getAuthorizationUrl: vi.fn() },
  },
}));

vi.mock("../../_utils/getAppKeysFromSlug", () => ({ default: mocks.getAppKeysFromSlug }));
vi.mock("../../_utils/oauth/createOAuthAppCredential", () => ({
  default: mocks.createOAuthAppCredential,
}));
vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: { updateWhereId: mocks.updateCredentialKey },
}));
vi.mock("@jsforce/jsforce-node", () => ({
  default: {
    Connection: vi.fn().mockImplementation(function (options: Record<string, unknown>) {
      mocks.connectionOptions.push(options);
      return mocks.connection;
    }),
  },
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
  const nonceHash = createHmac("sha256", STATE_SECRET).update(`${nonce}:${userId}`).digest("hex");
  return JSON.stringify({ returnTo, nonce, nonceHash });
};

const appOptionsFrom = (salesforce: Record<string, unknown>) => {
  const appOptions = EventTypeAppMetadataSchema.parse({ salesforce }).salesforce;
  if (!appOptions) throw new Error("salesforce app options were not parsed");
  return appOptions;
};

const serviceWith = (appOptions: Record<string, unknown> = {}) =>
  createSalesforceCrmServiceWithSalesforceType(buildCredential(), appOptions);

const appKeys = { consumer_key: "sf-consumer-key", consumer_secret: "sf-consumer-secret" };
const tokenResponse = {
  id: "https://login.salesforce.com/id/00D/005",
  issued_at: String(Date.now()),
  instance_url: "https://example.my.salesforce.com",
  signature: "signature",
  access_token: "sf-access-token",
  refresh_token: "sf-refresh-token",
  scope: "refresh_token full",
  token_type: "Bearer",
};

const buildCredential = (
  overrides: { issuedAt?: string; tokenLifetime?: number } = {}
): CredentialPayload => ({
  id: 1,
  type: "salesforce_crm",
  key: {
    access_token: "stored-access-token",
    refresh_token: "stored-refresh-token",
    instance_url: "https://example.my.salesforce.com",
    issued_at: overrides.issuedAt ?? String(Date.now()),
    token_lifetime: overrides.tokenLifetime ?? 7200,
  },
  userId: 1,
  appId: "salesforce",
  teamId: null,
  invalid: false,
  user: { email: "owner@example.com" },
  delegationCredentialId: null,
  encryptedKey: null,
});

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "salesforce_crm",
  title: "Planning",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  uid: "booking-1",
  responses: {
    name: { label: "Name", value: "Jane Doe" },
    email: { label: "Email", value: "jane@example.com" },
  },
  organizer: { name: "Owner", email: "owner@example.com", timeZone: "Europe/London", language },
  attendees: [{ name: "Jane Doe", email: "jane@example.com", timeZone: "Europe/London", language }],
  additionalNotes: "Bring notes",
  ...overrides,
});

const eventFields = [
  { name: "Custom_Text__c", type: "string", length: 255 },
  { name: "Confirmed__c", type: "boolean", length: 0 },
  { name: "Notes__c", type: "string", length: 255 },
];
const contactFields = [{ name: "Notes__c", type: "string", length: 255 }];

const setupEventConnection = () => {
  const records: Record<string, unknown[]> = {
    User: [{ Id: ORGANIZER_ID, Email: "owner@example.com" }],
    Contact: [{ Id: CONTACT_ID, Notes__c: null }],
    Event: [{ Id: EVENT_ID, Notes__c: null }],
  };
  mocks.connection.query.mockImplementation((soql: string) => {
    const sobject = Object.keys(records).find((name) => soql.includes(`FROM ${name}`));
    return Promise.resolve({ records: sobject ? records[sobject] : [] });
  });
  mocks.connection.describe.mockImplementation((sobject: string) =>
    Promise.resolve({ fields: sobject === "Event" ? eventFields : contactFields })
  );
};

const sobjectApis = () => {
  const make = (id: string) => ({
    create: vi.fn().mockResolvedValue({ success: true, id }),
    update: vi.fn().mockResolvedValue({ success: true, id }),
    delete: vi.fn().mockResolvedValue({ success: true, id }),
  });
  const event = make(EVENT_ID);
  const contact = make(CONTACT_ID);
  const lead = make(LEAD_ID);
  mocks.connection.sobject.mockImplementation((sobject: string) => {
    if (sobject === "Event") return event;
    if (sobject === "Lead") return lead;
    return contact;
  });
  return { event, contact, lead };
};

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", STATE_SECRET);
  mocks.getAppKeysFromSlug.mockReset().mockResolvedValue(appKeys);
  mocks.createOAuthAppCredential.mockReset().mockResolvedValue(undefined);
  mocks.updateCredentialKey.mockReset().mockResolvedValue(undefined);
  mocks.connectionOptions.length = 0;
  for (const fn of [
    mocks.connection.query,
    mocks.connection.search,
    mocks.connection.sobject,
    mocks.connection.describe,
    mocks.connection.oauth2.requestToken,
  ]) {
    fn.mockReset();
  }
  mocks.connection.oauth2.getAuthorizationUrl
    .mockReset()
    .mockReturnValue("https://login.salesforce.com/services/oauth2/authorize?client_id=sf-consumer-key");
  fetchMock.resetMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Salesforce OAuth add", () => {
  it("builds the consent URL with the configured consumer key and a signed state", async () => {
    const returnTo = `${APP_URL}/apps/installed/other?hl=salesforce`;
    const req = createRequest({ query: { state: JSON.stringify({ returnTo }) }, userId: 1 });
    const res = createResponse();
    await addSalesforce(req, res as unknown as NextApiResponse);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      url: "https://login.salesforce.com/services/oauth2/authorize?client_id=sf-consumer-key",
    });
    expect(mocks.connectionOptions[0]).toEqual({
      oauth2: {
        clientId: "sf-consumer-key",
        redirectUri: `${OAUTH_URL}/api/integrations/salesforce/callback`,
      },
    });
    const authArgs = mocks.connection.oauth2.getAuthorizationUrl.mock.calls[0][0];
    expect(authArgs.scope).toBe("refresh_token full");
    const state = JSON.parse(authArgs.state);
    expect(state.returnTo).toBe(returnTo);
    expect(state.nonceHash).toBe(createHmac("sha256", STATE_SECRET).update(`${state.nonce}:1`).digest("hex"));
  });
});

describe("Salesforce OAuth callback", () => {
  it("exchanges the code, introspects the token lifetime, stores the key, and redirects", async () => {
    const returnTo = `${APP_URL}/apps/installed/other?hl=salesforce`;
    mocks.connection.oauth2.requestToken.mockResolvedValue(tokenResponse);
    fetchMock.mockResponseOnce(JSON.stringify({ exp: 2000, iat: 200 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const res = createResponse();
    await salesforceCallback(
      createRequest({ query: { code: "auth-code", state: stateFor(1, returnTo) }, userId: 1 }),
      res as unknown as NextApiResponse
    );
    expect(mocks.connection.oauth2.requestToken).toHaveBeenCalledWith("auth-code");
    const [introspectUrl, introspectInit] = fetchMock.mock.calls[0];
    expect(String(introspectUrl)).toBe(`${tokenResponse.instance_url}/services/oauth2/introspect`);
    expect(introspectInit).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("sf-consumer-key:sf-consumer-secret").toString("base64")}`,
      },
    });
    expect(String(introspectInit?.body)).toContain("token=sf-access-token");
    expect(mocks.createOAuthAppCredential).toHaveBeenCalledWith(
      { appId: "salesforce", type: "salesforce_crm" },
      expect.objectContaining({
        access_token: "sf-access-token",
        refresh_token: "sf-refresh-token",
        token_lifetime: 1800,
      }),
      expect.anything()
    );
    expect(res.redirect).toHaveBeenCalledWith(returnTo);
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("sf-access-token");
    expect(JSON.stringify(res.redirect.mock.calls)).not.toContain("sf-refresh-token");
  });

  it("does not store a credential when the token exchange fails", async () => {
    mocks.connection.oauth2.requestToken.mockRejectedValue(new Error("invalid_grant"));
    await expect(
      salesforceCallback(
        createRequest({ query: { code: "auth-code" }, userId: 1 }),
        createResponse() as unknown as NextApiResponse
      )
    ).rejects.toThrow("invalid_grant");
    expect(mocks.createOAuthAppCredential).not.toHaveBeenCalled();
  });
});

describe("Salesforce token refresh", () => {
  it("refreshes an expired token, persists the new key, and connects with it", async () => {
    const credential = buildCredential({
      issuedAt: String(Date.now() - 60 * 60 * 1000),
      tokenLifetime: 1800,
    });
    const refreshed = {
      ...tokenResponse,
      access_token: "refreshed-access-token",
      issued_at: String(Date.now()),
    };
    fetchMock.mockResponseOnce(JSON.stringify(refreshed));
    mocks.connection.query.mockResolvedValue({ records: [] });
    const service = createSalesforceCrmServiceWithSalesforceType(credential, {});
    await service.getContacts({ emails: "jane@example.com" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://login.salesforce.com/services/oauth2/token");
    expect(init).toMatchObject({ method: "POST" });
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("sf-consumer-key");
    expect(body.get("client_secret")).toBe("sf-consumer-secret");
    expect(body.get("refresh_token")).toBe("stored-refresh-token");
    expect(mocks.updateCredentialKey).toHaveBeenCalledWith({
      id: 1,
      data: {
        key: expect.objectContaining({
          access_token: "refreshed-access-token",
          refresh_token: "stored-refresh-token",
          token_lifetime: 1800,
        }),
      },
    });
    expect(mocks.connectionOptions.at(-1)).toMatchObject({
      accessToken: "refreshed-access-token",
      instanceUrl: tokenResponse.instance_url,
    });
  });

  it("continues with the stored token when refresh fails", async () => {
    const credential = buildCredential({
      issuedAt: String(Date.now() - 60 * 60 * 1000),
      tokenLifetime: 1800,
    });
    fetchMock.mockResponseOnce(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      statusText: "Bad Request",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.connection.query.mockResolvedValue({ records: [] });
    const service = createSalesforceCrmServiceWithSalesforceType(credential, {});
    await expect(service.getContacts({ emails: "jane@example.com" })).resolves.toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    expect(mocks.updateCredentialKey).not.toHaveBeenCalled();
    expect(mocks.connectionOptions.at(-1)).toMatchObject({ accessToken: "stored-access-token" });
  });
});

describe("Salesforce contact and lead records", () => {
  it("creates the attendee on the configured record type", async () => {
    mocks.connection.query.mockImplementation((soql: string) =>
      soql.includes("FROM User WHERE Email")
        ? Promise.resolve({ records: [{ Id: ORGANIZER_ID }] })
        : Promise.resolve({ records: [] })
    );
    const { contact, lead } = sobjectApis();
    const attendee = { name: "Jane Doe", email: "jane@acme.example.com" };
    const contactResult = await serviceWith({ createEventOn: "Contact" }).createContacts(
      [attendee],
      "owner@example.com"
    );
    const leadResult = await serviceWith({ createEventOn: "Lead" }).createContacts(
      [attendee],
      "owner@example.com"
    );
    expect(contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        FirstName: "Jane",
        LastName: "Doe",
        Email: attendee.email,
        OwnerId: ORGANIZER_ID,
      })
    );
    expect(contact.create.mock.calls[0][0]).not.toHaveProperty("Company");
    expect(lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        FirstName: "Jane",
        LastName: "Doe",
        Email: attendee.email,
        Company: "acme",
        OwnerId: ORGANIZER_ID,
      })
    );
    expect(contactResult).toEqual([{ id: CONTACT_ID, email: attendee.email }]);
    expect(leadResult).toEqual([{ id: LEAD_ID, email: attendee.email }]);
  });

  it("looks up contacts and leads according to createEventOn", async () => {
    mocks.connection.query.mockImplementation((soql: string) =>
      soql.includes("FROM Lead")
        ? Promise.resolve({
            records: [{ Id: LEAD_ID, Email: "jane@example.com", attributes: { type: "Lead" } }],
          })
        : Promise.resolve({
            records: [{ Id: CONTACT_ID, Email: "jane@example.com", attributes: { type: "Contact" } }],
          })
    );
    const contacts = await serviceWith({ createEventOn: "Contact" }).getContacts({
      emails: "jane@example.com",
    });
    const leads = await serviceWith({ createEventOn: "Lead" }).getContacts({ emails: "jane@example.com" });
    expect(contacts).toEqual([{ id: CONTACT_ID, email: "jane@example.com", recordType: "Contact" }]);
    expect(leads).toEqual([{ id: LEAD_ID, email: "jane@example.com", recordType: "Lead" }]);
  });
});

describe("Salesforce booking events", () => {
  it("creates an event with attendee relations, owner, and mapped event fields", async () => {
    setupEventConnection();
    const { event } = sobjectApis();
    const service = serviceWith(
      appOptionsFrom({
        onBookingWriteToEventObject: true,
        onBookingWriteToEventObjectMap: { Custom_Text__c: "{name}", Confirmed__c: "true" },
      })
    );
    const result = await service.createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }]);
    expect(event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        Subject: "Planning",
        StartDateTime: "2024-01-15T09:00:00.000Z",
        EndDateTime: "2024-01-15T10:00:00.000Z",
        Description: expect.stringContaining("Bring notes"),
        EventWhoIds: [CONTACT_ID],
        OwnerId: ORGANIZER_ID,
        Custom_Text__c: "Jane Doe",
        Confirmed__c: "true",
      })
    );
    expect(result).toMatchObject({ uid: EVENT_ID, id: EVENT_ID, type: "salesforce_other_calendar" });
  });

  it("falls back to a single WhoId when EventWhoIds is unavailable", async () => {
    setupEventConnection();
    const { event } = sobjectApis();
    event.create
      .mockRejectedValueOnce("INVALID_FIELD: No such column 'EventWhoIds' on sobject of type Event")
      .mockResolvedValueOnce({ success: true, id: EVENT_ID });
    const result = await serviceWith().createEvent(buildEvent(), [
      { id: CONTACT_ID, email: "jane@example.com" },
    ]);
    expect(event.create).toHaveBeenCalledTimes(2);
    expect(event.create.mock.calls[1][0]).toEqual(expect.objectContaining({ WhoId: CONTACT_ID }));
    expect(event.create.mock.calls[1][0]).not.toHaveProperty("EventWhoIds");
    expect(result?.additionalInfo.calWarnings?.[0]).toContain("Allow Users to Relate Multiple Contacts");
  });

  it("rejects when Salesforce does not confirm event creation", async () => {
    setupEventConnection();
    const { event } = sobjectApis();
    event.create.mockResolvedValue({ success: false });
    await expect(
      serviceWith().createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }])
    ).rejects.toBe("Something went wrong when creating an event in Salesforce");
  });

  it("updates the Salesforce event on reschedule", async () => {
    setupEventConnection();
    const { event } = sobjectApis();
    const result = await serviceWith().updateEvent(EVENT_ID, buildEvent({ title: "Rescheduled" }));
    expect(event.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Id: EVENT_ID,
        Subject: "Rescheduled",
        StartDateTime: "2024-01-15T09:00:00.000Z",
        EndDateTime: "2024-01-15T10:00:00.000Z",
      })
    );
    expect(result).toMatchObject({ uid: EVENT_ID, id: EVENT_ID });
  });

  it("deletes the Salesforce event on cancellation", async () => {
    setupEventConnection();
    const { event } = sobjectApis();
    await serviceWith().deleteEvent(EVENT_ID, buildEvent());
    expect(event.delete).toHaveBeenCalledWith(EVENT_ID);
  });
  it("writes cancellation fields instead of deleting when configured", async () => {
    setupEventConnection();
    const { event } = sobjectApis();
    const service = serviceWith(
      appOptionsFrom({
        onCancelWriteToEventRecord: true,
        onCancelWriteToEventRecordFields: {
          Notes__c: {
            value: "Cancelled",
            fieldType: SalesforceFieldType.TEXT,
            whenToWrite: WhenToWriteToRecord.EVERY_BOOKING,
          },
        },
      })
    );
    await service.deleteEvent(EVENT_ID, buildEvent());
    expect(event.delete).not.toHaveBeenCalled();
    expect(event.update).toHaveBeenCalledWith({ Id: EVENT_ID, Notes__c: "Cancelled" });
  });
  it("maps the booking response onto the attendee record", async () => {
    setupEventConnection();
    const { event, contact } = sobjectApis();
    const service = serviceWith(
      appOptionsFrom({
        onBookingWriteToRecord: true,
        onBookingWriteToRecordFields: {
          Notes__c: {
            value: "{name}",
            fieldType: SalesforceFieldType.TEXT,
            whenToWrite: WhenToWriteToRecord.EVERY_BOOKING,
          },
        },
      })
    );
    await service.createEvent(buildEvent(), [{ id: CONTACT_ID, email: "jane@example.com" }]);
    expect(event.create).toHaveBeenCalled();
    expect(contact.update).toHaveBeenCalledWith({ Id: CONTACT_ID, Notes__c: "Jane Doe" });
  });
});
