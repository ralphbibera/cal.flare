import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import callback from "../api/callback";
import save from "../api/save";
import settings from "../api/settings";
import token from "../api/token";
import webhook from "../api/webhook";

const APP_URL = "http://app.cal.local:3000";
const USER_VITAL_ID = "vital-user-1";

const { prisma, vitalClient, vitalEnv, Reschedule } = vi.hoisted(() => ({
  prisma: {
    booking: { findMany: vi.fn() },
    credential: { create: vi.fn(), findFirstOrThrow: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
  },
  vitalClient: {
    Link: { create: vi.fn() },
    User: { create: vi.fn(), resolve: vi.fn() },
    Webhooks: { constructWebhookEvent: vi.fn() },
  },
  vitalEnv: { mode: "sandbox", region: "us", api_key: "vital-key", webhook_secret: "whsec" },
  Reschedule: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("../lib/client", () => ({
  initVitalClient: vi.fn(async () => vitalClient),
  vitalEnv,
}));
vi.mock("../lib", () => ({ Reschedule }));
vi.mock("@calcom/lib/logger", () => {
  const getSubLogger = () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    getSubLogger,
  });
  return { default: { ...getSubLogger(), getSubLogger } };
});

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
    setHeader: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    body: {},
    headers: {},
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.create.mockResolvedValue({ id: 1 });
  prisma.credential.findFirstOrThrow.mockResolvedValue({ userId: 1 });
  prisma.user.update.mockResolvedValue({});
  vitalClient.User.create.mockResolvedValue({ user_id: USER_VITAL_ID });
  vitalClient.User.resolve.mockResolvedValue({ user_id: USER_VITAL_ID });
  vitalClient.Link.create.mockResolvedValue({ link_token: "link-token" });
});

describe("Vital install", () => {
  it("creates the Vital user, stores only the Vital user id, and returns a link token", async () => {
    const res = createResponse();

    await token(buildRequest(), res as unknown as NextApiResponse);

    expect(vitalClient.User.create).toHaveBeenCalledWith("cal_1");
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: {
        type: "vital_other",
        key: { userVitalId: USER_VITAL_ID },
        userId: 1,
        appId: "vital-automation",
      },
    });
    expect(vitalClient.Link.create).toHaveBeenCalledWith(
      USER_VITAL_ID,
      undefined,
      `${APP_URL}/api/integrations/vital/callback`
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      token: "link-token",
      url: "https://link.tryvital.io/?env=sandbox&region=us",
    });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(USER_VITAL_ID);
  });

  it("rejects an unauthenticated token request", async () => {
    const res = createResponse();

    await token(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("marks the user connected on the OAuth callback and merges existing metadata", async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 1,
      metadata: { timeZone: "UTC", vitalSettings: { sleepValue: 6 } },
    });
    const res = createResponse();

    await callback(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        metadata: {
          timeZone: "UTC",
          vitalSettings: { sleepValue: 6, connected: true },
        },
      },
    });
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/other?hl=vital-automation");
  });
});

describe("Vital settings", () => {
  it("returns the stored vital settings", async () => {
    prisma.user.findFirst.mockResolvedValue({ metadata: { vitalSettings: { connected: true } } });
    const res = createResponse();

    await settings(buildRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ connected: true });
  });

  it("returns 404 when the user has no vital settings", async () => {
    prisma.user.findFirst.mockResolvedValue({ metadata: {} });
    const res = createResponse();

    await settings(buildRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
  });

  it("merges saved settings but returns the previous settings object", async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 1,
      metadata: { vitalSettings: { connected: true, sleepValue: 6 } },
    });
    const res = createResponse();

    await save(
      buildRequest({ method: "PUT", body: { sleepValue: 8, selectedParam: "total_sleep" } }),
      res as unknown as NextApiResponse
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        metadata: {
          vitalSettings: { connected: true, sleepValue: 8, selectedParam: "total_sleep" },
        },
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ connected: true, sleepValue: 6 });
  });

  it("rejects an invalid settings body", async () => {
    const res = createResponse();

    await save(
      buildRequest({ method: "PUT", body: { sleepValue: "not-a-number" } }),
      res as unknown as NextApiResponse
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("Vital sleep webhook", () => {
  it("reschedules today's bookings when sleep is below the configured minimum", async () => {
    const body = {
      event_type: "daily.data.sleep.created",
      data: { user_id: USER_VITAL_ID, total_sleep: 18_000 },
    };
    vitalClient.Webhooks.constructWebhookEvent.mockReturnValue(body);
    prisma.user.findFirst.mockResolvedValue({
      metadata: { vitalSettings: { sleepValue: 7, parameter: "total_sleep" } },
    });
    prisma.booking.findMany.mockResolvedValue([{ id: 1, uid: "booking-1" }]);
    Reschedule.mockResolvedValue(true);
    const res = createResponse();

    await webhook(
      buildRequest({ method: "POST", headers: { "svix-signature": "sig" }, body }),
      res as unknown as NextApiResponse
    );

    expect(vitalClient.Webhooks.constructWebhookEvent).toHaveBeenCalledWith(
      JSON.stringify(body),
      expect.objectContaining({ "svix-signature": "sig" }),
      "whsec"
    );
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 1 }) })
    );
    expect(Reschedule).toHaveBeenCalledWith("booking-1", "");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ body });
  });

  it("rejects a webhook without a svix signature", async () => {
    const res = createResponse();

    await webhook(buildRequest({ method: "POST" }), res as unknown as NextApiResponse);

    expect(vitalClient.Webhooks.constructWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Missing svix-signature" }));
  });
});
