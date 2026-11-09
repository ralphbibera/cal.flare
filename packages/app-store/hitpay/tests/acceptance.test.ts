import { createHmac } from "node:crypto";
import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import type { NextApiRequest, NextApiResponse } from "next";
import qs from "qs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import callback from "../api/callback";
import webhook from "../api/webhook";

const SANDBOX_KEY = "sandbox-api-key";
const SANDBOX_SALT = "sandbox-salt-key";
const PROD_KEY = "prod-api-key";
const PROD_SALT = "prod-salt-key";

const CREDENTIALS = {
  key: {
    isSandbox: true,
    sandbox: { apiKey: SANDBOX_KEY, saltKey: SANDBOX_SALT },
    prod: { apiKey: PROD_KEY, saltKey: PROD_SALT },
  },
};

const { prisma, handlePaymentSuccessMock, getUserAdminTeams } = vi.hoisted(() => ({
  prisma: {
    credential: { findFirst: vi.fn(), create: vi.fn() },
    payment: { findFirst: vi.fn() },
    booking: { update: vi.fn() },
  },
  handlePaymentSuccessMock: vi.fn(),
  getUserAdminTeams: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: handlePaymentSuccessMock,
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    getUserAdminTeams = getUserAdminTeams;
  },
}));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    redirect: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  res.end.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url: "/api/integrations/hitpay/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildWebhookRequest = (body: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  ({
    method: "POST",
    body,
    headers: {},
    query: {},
    url: "/api/integrations/hitpay/webhook",
    ...overrides,
  }) as unknown as NextApiRequest;

const signatureFor = (payload: Record<string, string>, salt = SANDBOX_SALT) => {
  const source = Object.keys(payload)
    .sort()
    .map((key) => `${key}${payload[key]}`)
    .join("");
  return createHmac("sha256", salt).update(source, "utf-8").digest("hex");
};

const webhookPayload = (overrides: Record<string, string> = {}) => {
  const payload = {
    payment_id: "payment-1",
    payment_request_id: "request-1",
    phone: "+6512345678",
    amount: "50",
    currency: "usd",
    status: "completed",
    reference_number: "10",
    ...overrides,
  };
  return { ...payload, hmac: signatureFor(payload) };
};

const paymentForCallback = (status = "completed") => ({
  id: 1,
  amount: 5000,
  bookingId: 10,
  status,
  data: {
    id: "hitpay-request-id",
    url: "https://securecheckout.sandbox.hit-pay.com/payment-request/test",
    defaultLink: "https://securecheckout.sandbox.hit-pay.com/payment-request/test",
    email: "booker@example.com",
  },
  booking: {
    uid: "booking-uid",
    userId: 7,
    user: { email: "jane@example.com", username: "jane" },
    responses: {},
    eventType: { slug: "paid-event", teamId: null },
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 3 });
  prisma.booking.update.mockResolvedValue({ id: 10 });
  prisma.payment.findFirst.mockResolvedValue({
    id: 1,
    amount: 5000,
    bookingId: 10,
    booking: { userId: 7, eventType: { teamId: null } },
  });
  getUserAdminTeams.mockResolvedValue({ teams: [{ team: { id: 5 } }] });
  handlePaymentSuccessMock.mockResolvedValue({ ok: true });
});

describe("HitPay install", () => {
  it("creates an empty user credential and points at the setup page", async () => {
    const res = createResponse();

    await add(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "hitpay_payment", key: {}, appId: "hitpay", userId: 1 },
    });
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/hitpay/setup" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(SANDBOX_SALT);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(PROD_KEY);
  });

  it("installs for an admin team and keeps the team in the redirect", async () => {
    const res = createResponse();

    await add(buildRequest({ query: { teamId: "5" } }), res as unknown as NextApiResponse);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "hitpay_payment", key: {}, appId: "hitpay", teamId: 5 },
    });
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/hitpay/setup?teamId=5" });
  });

  it("rejects non-admin team installs, duplicates and unauthenticated requests", async () => {
    getUserAdminTeams.mockResolvedValue({ teams: [] });
    await expect(
      add(buildRequest({ query: { teamId: "5" } }), createResponse() as unknown as NextApiResponse)
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "You must be an admin of the team to do this",
    });

    prisma.credential.findFirst.mockResolvedValue({ id: 3 });
    const duplicate = createResponse();
    await add(buildRequest(), duplicate as unknown as NextApiResponse);
    expect(duplicate.json).toHaveBeenCalledWith({ message: "Already installed" });

    const unauthenticated = createResponse();
    await add(buildRequest({ session: undefined }), unauthenticated as unknown as NextApiResponse);
    expect(unauthenticated.status).toHaveBeenCalledWith(401);
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("HitPay callback", () => {
  beforeEach(() => {
    prisma.payment.findFirst.mockResolvedValue(paymentForCallback());
    prisma.credential.findFirst.mockResolvedValue({ key: CREDENTIALS.key });
  });

  it("redirects a completed payment to the booking with the attendee details", async () => {
    const res = createResponse();

    await callback(
      buildRequest({ query: { reference: "request-1", status: "completed" } }),
      res as unknown as NextApiResponse
    );

    const query = qs.stringify({
      "flag.coep": false,
      isSuccessBookingPage: true,
      email: "booker@example.com",
      eventTypeSlug: "paid-event",
    });
    expect(res.redirect).toHaveBeenCalledWith(`/booking/booking-uid?${query}`);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it("cancels the booking and returns to the event page for a failed payment", async () => {
    const res = createResponse();

    await callback(
      buildRequest({ query: { reference: "request-1", status: "failed" } }),
      res as unknown as NextApiResponse
    );

    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { status: "CANCELLED" },
    });
    expect(res.redirect).toHaveBeenCalledWith("/jane/paid-event");
  });

  it("reports missing references, payments, credentials and booking data", async () => {
    await expect(
      callback(buildRequest({ query: {} }), createResponse() as unknown as NextApiResponse)
    ).rejects.toMatchObject({ statusCode: 204, message: "Reference not found" });

    prisma.payment.findFirst.mockResolvedValueOnce(null);
    await expect(
      callback(
        buildRequest({ query: { reference: "request-1", status: "completed" } }),
        createResponse() as unknown as NextApiResponse
      )
    ).rejects.toMatchObject({ statusCode: 204, message: "Payment not found" });

    prisma.payment.findFirst.mockResolvedValueOnce(paymentForCallback());
    prisma.credential.findFirst.mockResolvedValueOnce(null);
    await expect(
      callback(
        buildRequest({ query: { reference: "request-1", status: "completed" } }),
        createResponse() as unknown as NextApiResponse
      )
    ).rejects.toMatchObject({ statusCode: 204, message: "Credential not found" });

    prisma.payment.findFirst.mockResolvedValueOnce({
      ...paymentForCallback(),
      booking: { ...paymentForCallback().booking, user: null, eventType: null },
    });
    prisma.credential.findFirst.mockResolvedValueOnce({ key: CREDENTIALS.key });
    await expect(
      callback(
        buildRequest({ query: { reference: "request-1", status: "failed" } }),
        createResponse() as unknown as NextApiResponse
      )
    ).rejects.toMatchObject({ statusCode: 204, message: "Booking not correct" });
  });
});

describe("HitPay webhook", () => {
  beforeEach(() => {
    prisma.credential.findFirst.mockResolvedValue({ key: CREDENTIALS.key });
  });

  it("verifies the HMAC and confirms a completed payment", async () => {
    const payload = webhookPayload();
    const res = createResponse();

    const result = await webhook(buildWebhookRequest(payload), res as unknown as NextApiResponse);

    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { externalId: "request-1" },
      select: {
        id: true,
        amount: true,
        bookingId: true,
        booking: {
          select: {
            userId: true,
            eventType: { select: { teamId: true } },
          },
        },
      },
    });
    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { type: "hitpay_payment", userId: 7 },
    });
    expect(handlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 1, bookingId: 10, appSlug: "hitpay" })
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a bad HMAC with the baseline 200 acknowledgement", async () => {
    const payload = { ...webhookPayload(), hmac: "0".repeat(64) };
    const res = createResponse();

    await webhook(buildWebhookRequest(payload), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Bad Request" }));
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("acknowledges non-completed payments without confirming them", async () => {
    const payload = webhookPayload({ status: "pending" });
    const res = createResponse();

    await webhook(buildWebhookRequest(payload), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Payment is pending" }));
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("reports payment and credential problems without confirming", async () => {
    const payload = webhookPayload();

    prisma.payment.findFirst.mockResolvedValueOnce(null);
    const missingPayment = createResponse();
    await webhook(buildWebhookRequest(payload), missingPayment as unknown as NextApiResponse);
    expect(missingPayment.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Payment not found" })
    );

    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 1,
      amount: 5000,
      bookingId: 10,
      booking: { userId: 7, eventType: { teamId: null } },
    });
    prisma.credential.findFirst.mockResolvedValueOnce(null);
    const missingCredential = createResponse();
    await webhook(buildWebhookRequest(payload), missingCredential as unknown as NextApiResponse);
    expect(missingCredential.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Credentials not found" })
    );

    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 1,
      amount: 5000,
      bookingId: 10,
      booking: { userId: 7, eventType: { teamId: null } },
    });
    prisma.credential.findFirst.mockResolvedValueOnce({
      key: { isSandbox: true, prod: { apiKey: PROD_KEY, saltKey: PROD_SALT } },
    });
    const missingSandbox = createResponse();
    await webhook(buildWebhookRequest(payload), missingSandbox as unknown as NextApiResponse);
    expect(missingSandbox.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Sandbox Credentials not found" })
    );
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests", async () => {
    const wrongMethod = createResponse();

    await webhook(
      buildWebhookRequest(webhookPayload(), { method: "GET" }),
      wrongMethod as unknown as NextApiResponse
    );

    expect(wrongMethod.status).toHaveBeenCalledWith(200);
    expect(wrongMethod.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Method Not Allowed" }));
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });
});
