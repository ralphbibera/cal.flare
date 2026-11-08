import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import check from "../api/check";
import BuildCalendarService from "../lib/CalendarService";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
const API_KEY = "SG.sendgrid-api-key";

vi.hoisted(() => {
  globalThis.process.env.CALENDSO_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
});

const { prisma, findByAppIdAndUserId, sendgridRequest, sendgridUsername, constructorKeys } = vi.hoisted(
  () => ({
    prisma: { credential: { create: vi.fn() } },
    findByAppIdAndUserId: vi.fn(),
    sendgridRequest: vi.fn(),
    sendgridUsername: vi.fn(),
    constructorKeys: [] as string[],
  })
);

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: { findByAppIdAndUserId },
}));
vi.mock("@calcom/lib/Sendgrid", () => ({
  default: class MockSendgrid {
    constructor(key: string) {
      constructorKeys.push(key);
    }
    sendgridRequest = sendgridRequest;
    username = sendgridUsername;
  },
}));

const translate = ((key: string) => key) as never;

const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "Consultation",
  title: "Planning",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  organizer: {
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

const encryptedKey = () => ({
  encrypted: symmetricEncrypt(JSON.stringify({ api_key: API_KEY }), ENCRYPTION_KEY),
});

const buildCredential = (key: Record<string, unknown> = encryptedKey()): CredentialPayload => ({
  id: 1,
  type: "sendgrid_other_calendar",
  appId: "sendgrid",
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
  setHeader: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

beforeEach(() => {
  vi.resetAllMocks();
  constructorKeys.length = 0;
  findByAppIdAndUserId.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 1 });
  sendgridUsername.mockResolvedValue({ username: "jane" });
});

describe("Sendgrid API-key install", () => {
  it("encrypts the API key, stores it, and returns only the installed app path", async () => {
    const res = createResponse();

    await add(
      buildRequest({ method: "POST", body: { api_key: API_KEY } }),
      res as unknown as NextApiResponse
    );

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; key: { encrypted: string }; userId: number; appId: string };
    };
    expect(stored.data).toMatchObject({
      type: "sendgrid_other_calendar",
      userId: 1,
      appId: "sendgrid",
    });
    expect(JSON.parse(symmetricDecrypt(stored.data.key.encrypted, ENCRYPTION_KEY))).toEqual({
      api_key: API_KEY,
    });
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/other?hl=sendgrid" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(API_KEY);
  });

  it("validates an API key through the Sendgrid username endpoint", async () => {
    const res = createResponse();

    await check(
      buildRequest({ method: "POST", body: { api_key: API_KEY } }),
      res as unknown as NextApiResponse
    );

    expect(constructorKeys).toEqual([API_KEY]);
    expect(sendgridUsername).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({});
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(API_KEY);
  });
});

describe("Sendgrid calendar service", () => {
  it("creates marketing contacts for the booking attendees", async () => {
    sendgridRequest.mockResolvedValue({ job_id: "job-1" });
    const calendar = BuildCalendarService(buildCredential());

    const result = await calendar.createEvent(buildEvent());

    expect(sendgridRequest).toHaveBeenCalledWith({
      url: "/v3/marketing/contacts",
      method: "PUT",
      body: {
        contacts: [{ first_name: "Alex", email: "alex@example.com" }],
      },
    });
    expect(result).toEqual({
      id: "",
      uid: "job-1",
      password: "",
      url: "",
      type: "sendgrid_other_calendar",
      additionalInfo: { result: { job_id: "job-1" } },
    });
  });
});
