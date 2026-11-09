import type { CalendarEvent } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest } from "next";
import { vi } from "vitest";

export const createResponse = () => {
  const res = { status: vi.fn(), json: vi.fn(), redirect: vi.fn(), setHeader: vi.fn(), writableEnded: false };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  return res;
};

export const buildRequest = (url: string, overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url,
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

export const buildResponse = (body: unknown, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });

const translate = ((key: string) => key) as never;

export const buildEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  type: "Consultation",
  title: "Planning Session",
  startTime: "2024-01-15T09:00:00Z",
  endTime: "2024-01-15T10:00:00Z",
  organizer: { name: "Jane Doe", email: "jane@example.com", timeZone: "UTC", language: { translate, locale: "en" } },
  attendees: [],
  description: "Planning session",
  ...overrides,
});

export const buildCredential = (overrides: Partial<CredentialPayload> = {}): CredentialPayload => ({
  id: 1,
  type: "video",
  appId: "app",
  userId: 1,
  teamId: null,
  invalid: false,
  delegationCredentialId: null,
  encryptedKey: null,
  user: { email: "jane@example.com" },
  key: {},
  ...overrides,
});
