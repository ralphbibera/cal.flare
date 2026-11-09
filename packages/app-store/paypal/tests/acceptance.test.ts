import { Readable } from "node:stream";
import { WEBAPP_URL } from "@calcom/lib/constants";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "vitest-fetch-mock";

import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import add from "../api/add";
import webhook, { handlePaypalPaymentSuccess } from "../api/webhook";
import { BuildPaymentService } from "../lib/PaymentService";

const CLIENT_ID = "paypal-client-id";
const CLIENT_SECRET = "paypal-client-secret";
const WEBHOOK_ID = "paypal-webhook-id";
const ACCESS_TOKEN = "paypal-access-token";
const BOOKING_UID = "booking-uid";
const ORDER_ID = "ORDER-1";
const RAW_PAYLOAD = JSON.stringify({
  id: "WH-EVENT-1",
  create_time: "2026-04-01T10:00:00Z",
  resource_type: "checkout-order",
  event_type: "CHECKOUT.ORDER.APPROVED",
  summary: "An order has been approved by buyer",
  resource: {
    create_time: "2026-04-01T10:00:00Z",
    id: ORDER_ID,
    payment_source: { paypal: {} },
    intent: "CAPTURE",
    payer: {
      email_address: "alex@example.com",
      payer_id: "PAYER-1",
      address: { country_code: "US" },
    },
    status: "APPROVED",
  },
  event_version: "1.0",
  resource_version: "1.0",
});

const CREDENTIALS = {
  key: { client_id: CLIENT_ID, secret_key: CLIENT_SECRET, webhook_id: WEBHOOK_ID },
};

const { prisma, handlePaymentSuccessMock } = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    booking: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    credential: { findFirst: vi.fn(), create: vi.fn() },
    payment: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
  handlePaymentSuccessMock: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: handlePaymentSuccessMock,
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
    url: "/api/integrations/paypal/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildRawRequest = (body: string, overrides: Record<string, unknown> = {}) =>
  Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    headers: {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.paypal.com/cert.pem",
      "paypal-transmission-id": "transmission-1",
      "paypal-transmission-sig": "signature-1",
      "paypal-transmission-time": "2026-04-01T10:00:00Z",
    },
    query: {},
    url: "/api/integrations/paypal/webhook",
    ...overrides,
  }) as unknown as NextApiRequest;

const buildService = () => BuildPaymentService(CREDENTIALS);

const mockToken = () =>
  fetchMock.mockResponseOnce(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }));

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.resetMocks();
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 3 });
  prisma.booking.findUnique.mockResolvedValue({ uid: BOOKING_UID, title: "Paid event" });
  prisma.booking.findFirst.mockResolvedValue({ id: 20, userId: 7 });
  prisma.payment.findFirst.mockResolvedValue({ id: 10, bookingId: 20 });
  prisma.payment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 10,
    ...data,
  }));
  handlePaymentSuccessMock.mockResolvedValue({ ok: true });
});

describe("PayPal install", () => {
  it("creates an empty credential and points the user at the setup page", async () => {
    const res = createResponse();

    await add(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "paypal_payment", key: {}, userId: 1, appId: "paypal" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/paypal/setup" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(WEBHOOK_ID);
  });

  it("refuses to install twice", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 3 });
    const res = createResponse();

    await add(buildRequest(), res as unknown as NextApiResponse);

    expect(res.json).toHaveBeenCalledWith({ message: "Already installed" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated install", async () => {
    const res = createResponse();

    await add(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
  });
});

describe("PayPal payment creation", () => {
  it("creates a PayPal order with the booking amount, currency and return URLs", async () => {
    mockToken();
    fetchMock.mockResponseOnce(JSON.stringify({ id: ORDER_ID, status: "CREATED" }));

    const payment = await buildService().create({ amount: 1050, currency: "USD" }, 42);

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(tokenOptions).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
    });
    expect(tokenOptions.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(tokenOptions.body as URLSearchParams)).toEqual({
      grant_type: "client_credentials",
    });

    const [orderUrl, orderOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(orderUrl).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(orderOptions).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    const stored = prisma.payment.create.mock.calls[0][0] as {
      data: { uid: string; [key: string]: unknown };
    };
    expect(JSON.parse(orderOptions.body as string)).toEqual({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: stored.data.uid,
          amount: { currency_code: "USD", value: "10.5" },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: "PAY_NOW",
            return_url: `${WEBAPP_URL}/api/integrations/paypal/capture?bookingUid=${BOOKING_UID}`,
            cancel_url: `${WEBAPP_URL}/payment/${stored.data.uid}`,
          },
        },
      },
    });

    expect(stored.data).toMatchObject({
      amount: 1050,
      currency: "USD",
      externalId: ORDER_ID,
      app: { connect: { slug: "paypal" } },
      booking: { connect: { id: 42 } },
      data: { order: { id: ORDER_ID, status: "CREATED" } },
      fee: 0,
      refunded: false,
      success: false,
    });
    expect(payment).toMatchObject({ id: 10, externalId: ORDER_ID });
    expect(JSON.stringify(stored.data.data)).not.toContain(CLIENT_SECRET);
  });

  it("returns a creation error when the booking does not exist", async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    await expect(buildService().create({ amount: 1050, currency: "USD" }, 42)).rejects.toThrow(
      "payment_not_created_error"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("rejects card collection for the unsupported HOLD option", async () => {
    await expect(
      buildService().collectCard({ amount: 1050, currency: "USD" }, 42, "HOLD", "alex@example.com")
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not implement refunds or cancellation", async () => {
    const service = buildService();

    await expect(service.refund()).rejects.toThrow("Method not implemented.");
    await expect(service.deletePayment()).resolves.toBe(false);
  });
});

describe("PayPal webhook", () => {
  beforeEach(() => {
    prisma.credential.findFirst.mockResolvedValue({ key: CREDENTIALS.key });
  });

  it("verifies the signature and confirms the booking", async () => {
    mockToken();
    fetchMock.mockResponseOnce(JSON.stringify({ verification_status: "SUCCESS" }));

    await handlePaypalPaymentSuccess(
      JSON.parse(RAW_PAYLOAD) as Parameters<typeof handlePaypalPaymentSuccess>[0],
      RAW_PAYLOAD,
      {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.paypal.com/cert.pem",
        "paypal-transmission-id": "transmission-1",
        "paypal-transmission-sig": "signature-1",
        "paypal-transmission-time": "2026-04-01T10:00:00Z",
      }
    );

    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { externalId: ORDER_ID },
      select: { id: true, bookingId: true },
    });
    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { appId: "paypal", userId: 7 },
      select: { key: true },
    });

    const [verifyUrl, verifyOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(verifyUrl).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(verifyOptions.method).toBe("POST");
    expect(JSON.parse(verifyOptions.body as string)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.paypal.com/cert.pem",
      transmission_id: "transmission-1",
      transmission_sig: "signature-1",
      transmission_time: "2026-04-01T10:00:00Z",
      webhook_id: WEBHOOK_ID,
      // Cal.diy splices the parsed event into the verification body without re-stringifying it.
      webhook_event: JSON.parse(RAW_PAYLOAD),
    });

    expect(handlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 10, bookingId: 20, appSlug: "paypal" })
    );
  });

  it("refuses to confirm when PayPal rejects the signature", async () => {
    mockToken();
    fetchMock.mockResponseOnce(JSON.stringify({ verification_status: "FAILURE" }));

    await expect(
      handlePaypalPaymentSuccess(
        JSON.parse(RAW_PAYLOAD) as Parameters<typeof handlePaypalPaymentSuccess>[0],
        RAW_PAYLOAD,
        {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.paypal.com/cert.pem",
          "paypal-transmission-id": "transmission-1",
          "paypal-transmission-sig": "signature-1",
          "paypal-transmission-time": "2026-04-01T10:00:00Z",
        }
      )
    ).rejects.toEqual({ verification_status: "FAILURE" });
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("returns 204 when the order is unknown", async () => {
    prisma.payment.findFirst.mockResolvedValue(null);

    await expect(
      handlePaypalPaymentSuccess(
        JSON.parse(RAW_PAYLOAD) as Parameters<typeof handlePaypalPaymentSuccess>[0],
        RAW_PAYLOAD,
        {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.paypal.com/cert.pem",
          "paypal-transmission-id": "transmission-1",
          "paypal-transmission-sig": "signature-1",
          "paypal-transmission-time": "2026-04-01T10:00:00Z",
        }
      )
    ).rejects.toMatchObject({ statusCode: 204, message: "Payment not found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delegates an approved order through the route handler", async () => {
    mockToken();
    fetchMock.mockResponseOnce(JSON.stringify({ verification_status: "SUCCESS" }));
    const res = createResponse();

    const result = await webhook(buildRawRequest(RAW_PAYLOAD), res as unknown as NextApiResponse);

    // The approved path returns the confirmation result instead of ending the response itself.
    expect(result).toEqual({ ok: true });
    expect(handlePaymentSuccess).toHaveBeenCalled();
  });

  it("rejects a request with missing PayPal signature headers", async () => {
    const res = createResponse();
    const req = buildRawRequest(RAW_PAYLOAD, { headers: {} });

    await webhook(req, res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Bad Request" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-POST request", async () => {
    const res = createResponse();
    const req = buildRawRequest(RAW_PAYLOAD, { method: "GET" });
    await webhook(req, res as unknown as NextApiResponse);

    // Cal.diy returns 200 for every webhook error and carries the real status only in the message.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Method Not Allowed" }));
  });

  it("ignores events other than an approved order", async () => {
    const payload = { ...JSON.parse(RAW_PAYLOAD), event_type: "CHECKOUT.ORDER.COMPLETED" };
    const res = createResponse();

    await webhook(buildRawRequest(JSON.stringify(payload)), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalled();
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });
});
