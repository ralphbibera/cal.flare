import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import webhook from "../api/webhook";
import { BuildPaymentService } from "../lib/PaymentService";

const SERVER_URL = "https://btcpay.example.com";
const STORE_ID = "store-1";
const API_KEY = "btcpay-api-key";
const WEBHOOK_SECRET = "btcpay-webhook-secret";
const INVOICE_ID = "invoice-1";

const CREDENTIALS = {
  key: {
    serverUrl: SERVER_URL,
    storeId: STORE_ID,
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
  },
};

const { prisma, handlePaymentSuccessMock, createPaymentRecord, findByExternalId } = vi.hoisted(() => ({
  prisma: {
    credential: { create: vi.fn() },
  },
  handlePaymentSuccessMock: vi.fn(),
  createPaymentRecord: vi.fn(),
  findByExternalId: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: handlePaymentSuccessMock,
}));

vi.mock("@calcom/features/bookings/repositories/PrismaBookingPaymentRepository", () => ({
  PrismaBookingPaymentRepository: class {
    createPaymentRecord = createPaymentRecord;
    findByExternalIdIncludeBookingUserCredentials = findByExternalId;
  },
}));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  res.end.mockReturnValue(res);
  return res;
};

const buildRequest = (body: string, overrides: Record<string, unknown> = {}) =>
  Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    headers: {},
    query: {},
    url: "/api/integrations/btcpayserver/webhook",
    ...overrides,
  }) as unknown as NextApiRequest;

const buildService = () => BuildPaymentService(CREDENTIALS);

const invoiceResponse = {
  id: INVOICE_ID,
  checkoutLink: "https://btcpay.example.com/i/invoice-1",
  status: "New",
  amount: "10.5",
  currency: "USD",
  createdTime: 1_700_000_000,
  expirationTime: 1_700_000_900,
};

const webhookPayload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    deliveryId: "delivery-1",
    webhookId: "webhook-1",
    isRedelivery: false,
    type: "InvoiceSettled",
    timestamp: 1_700_000_000,
    storeId: STORE_ID,
    invoiceId: INVOICE_ID,
    overPaid: false,
    ...overrides,
  });

const signatureFor = (body: string, secret = WEBHOOK_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")}`;

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.resetMocks();
  prisma.credential.create.mockResolvedValue({ id: 3 });
  createPaymentRecord.mockImplementation(async (data: Record<string, unknown>) => ({
    id: 10,
    ...data,
  }));
  handlePaymentSuccessMock.mockResolvedValue({ ok: true });
  fetchMock.mockResponseOnce(JSON.stringify(invoiceResponse));
});

describe("BTCPay Server install", () => {
  it("creates the default credential and redirects to the setup page", async () => {
    const credential = await add.createCredential?.({
      appType: add.appType,
      user: { id: 1 },
      slug: add.slug,
    });

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "btcpayserver_payment",
        key: {},
        userId: 1,
        appId: "btcpayserver",
      }),
    });
    expect(credential).toMatchObject({ id: 3 });
    expect(add).toMatchObject({
      appType: "btcpayserver_payment",
      variant: "payment",
      slug: "btcpayserver",
      supportsMultipleInstalls: false,
      redirect: { url: "/apps/btcpayserver/setup" },
    });
    expect(JSON.stringify(add)).not.toContain(API_KEY);
    expect(JSON.stringify(add)).not.toContain(WEBHOOK_SECRET);
  });
});

describe("BTCPay Server payment creation", () => {
  it("creates an invoice with the booking metadata and stores the payment", async () => {
    const payment = await buildService().create(
      { amount: 1050, currency: "USD" },
      42,
      7,
      "jane",
      "Alex",
      "ON_BOOKING",
      "alex@example.com",
      "+15551234567",
      "Consultation",
      "Planning session"
    );

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVER_URL}/api/v1/stores/${STORE_ID}/invoices`);
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `token ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    const body = JSON.parse(options.body as string) as {
      metadata: { referenceId: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    expect(body).toMatchObject({
      metadata: {
        orderId: "cal-booking-42",
        itemDesc: "Planning session",
        appId: "cal.com",
        customerName: "Alex",
        customerEmail: "alex@example.com",
        bookingDescription: "Planning session",
      },
      checkout: { buyerEmail: "alex@example.com" },
      receipt: { enabled: true },
      amount: 10.5,
      currency: "USD",
      additionalSearchTerms: ["cal-booking-42", "Alex", "alex@example.com"],
    });

    expect(createPaymentRecord).toHaveBeenCalledWith({
      uid: body.metadata.referenceId,
      app: { connect: { slug: "btcpayserver" } },
      booking: { connect: { id: 42 } },
      amount: 1050,
      externalId: INVOICE_ID,
      currency: "USD",
      fee: 0,
      success: false,
      refunded: false,
      data: {
        invoice: {
          ...invoiceResponse,
          isPaid: false,
          attendee: { name: "Alex", email: "alex@example.com" },
        },
      },
    });
    expect(payment).toMatchObject({ id: 10, externalId: INVOICE_ID });
    expect(JSON.stringify(payment)).not.toContain(API_KEY);
  });

  it("sends BTC as SATS without scaling the amount", async () => {
    const btcInvoice = { ...invoiceResponse, amount: "2500", currency: "SATS" };
    fetchMock.resetMocks();
    fetchMock.mockResponseOnce(JSON.stringify(btcInvoice));

    await buildService().create(
      { amount: 2500, currency: "BTC" },
      42,
      7,
      "jane",
      "Alex",
      "ON_BOOKING",
      "alex@example.com"
    );

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toMatchObject({ amount: 2500, currency: "SATS" });
    expect(createPaymentRecord).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2500, currency: "BTC" })
    );
  });

  it("wraps missing configuration and API failures in the creation error", async () => {
    await expect(
      BuildPaymentService({ key: { ...CREDENTIALS.key, storeId: "" } }).create(
        { amount: 1050, currency: "USD" },
        42,
        7,
        "jane",
        "Alex",
        "ON_BOOKING",
        "alex@example.com"
      )
    ).rejects.toThrow("payment_not_created_error");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.resetMocks();
    fetchMock.mockResponseOnce("store not found", { status: 404 });
    await expect(
      buildService().create(
        { amount: 1050, currency: "USD" },
        42,
        7,
        "jane",
        "Alex",
        "ON_BOOKING",
        "alex@example.com"
      )
    ).rejects.toThrow("payment_not_created_error");
    expect(createPaymentRecord).not.toHaveBeenCalled();
  });

  it("does not support refunds or cancellation", async () => {
    const service = buildService();

    await expect(service.refund()).rejects.toThrow(
      "BTCPay Server does not support automatic refunds for Bitcoin payments"
    );
    await expect(service.deletePayment()).resolves.toBe(false);
  });
});

describe("BTCPay Server webhook", () => {
  beforeEach(() => {
    findByExternalId.mockResolvedValue({
      id: 10,
      bookingId: 20,
      success: false,
      booking: { user: { credentials: [{ key: CREDENTIALS.key }] } },
    });
  });

  it("verifies the HMAC and confirms the booking", async () => {
    const body = webhookPayload();
    const res = createResponse();

    await webhook(
      buildRequest(body, { headers: { "btcpay-sig": signatureFor(body) } }),
      res as unknown as NextApiResponse
    );

    expect(findByExternalId).toHaveBeenCalledWith(INVOICE_ID, "btcpayserver_payment");
    expect(handlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 10, bookingId: 20, appSlug: "btcpayserver" })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it("rejects a bad signature", async () => {
    const body = webhookPayload();
    const res = createResponse();

    await webhook(
      buildRequest(body, { headers: { "btcpay-sig": signatureFor(body, "wrong-secret") } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "signature mismatch" }));
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("rejects a store id that does not match the credential", async () => {
    const body = webhookPayload({ storeId: "other-store" });
    const res = createResponse();

    await webhook(
      buildRequest(body, { headers: { "btcpay-sig": signatureFor(body) } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Cal.diy: Store ID mismatch" }));
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("rejects missing, malformed and non-POST requests", async () => {
    const missingSignature = createResponse();
    await webhook(buildRequest(webhookPayload()), missingSignature as unknown as NextApiResponse);
    expect(missingSignature.status).toHaveBeenCalledWith(401);
    expect(missingSignature.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Missing or invalid signature format" })
    );

    const malformedSignature = createResponse();
    await webhook(
      buildRequest(webhookPayload(), { headers: { "btcpay-sig": "sha256=not-hex" } }),
      malformedSignature as unknown as NextApiResponse
    );
    expect(malformedSignature.status).toHaveBeenCalledWith(400);

    const malformedPayload = createResponse();
    await webhook(
      buildRequest("{not-json", { headers: { "btcpay-sig": signatureFor("{not-json") } }),
      malformedPayload as unknown as NextApiResponse
    );
    // JSON.parse runs before the schema check, so malformed JSON surfaces as a 500.
    expect(malformedPayload.status).toHaveBeenCalledWith(500);

    const wrongMethod = createResponse();
    await webhook(
      buildRequest(webhookPayload(), {
        method: "GET",
        headers: { "btcpay-sig": signatureFor(webhookPayload()) },
      }),
      wrongMethod as unknown as NextApiResponse
    );
    expect(wrongMethod.status).toHaveBeenCalledWith(405);
  });

  it("ignores unsupported invoice events", async () => {
    const body = webhookPayload({ type: "InvoiceExpired" });
    const res = createResponse();

    await webhook(
      buildRequest(body, { headers: { "btcpay-sig": signatureFor(body) } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: "Webhook received but ignored" });
    expect(findByExternalId).not.toHaveBeenCalled();
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("reports unknown payments, paid payments and credential problems", async () => {
    const body = webhookPayload();
    const headers = { "btcpay-sig": signatureFor(body) };

    findByExternalId.mockResolvedValueOnce(null);
    const missingPayment = createResponse();
    await webhook(buildRequest(body, { headers }), missingPayment as unknown as NextApiResponse);
    expect(missingPayment.status).toHaveBeenCalledWith(404);
    expect(missingPayment.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Cal.diy: payment not found" })
    );

    findByExternalId.mockResolvedValueOnce({ id: 10, bookingId: 20, success: true });
    const alreadyPaid = createResponse();
    await webhook(buildRequest(body, { headers }), alreadyPaid as unknown as NextApiResponse);
    expect(alreadyPaid.status).toHaveBeenCalledWith(200);
    expect(alreadyPaid.send).toHaveBeenCalledWith({ message: "Payment already registered" });
    expect(handlePaymentSuccess).not.toHaveBeenCalled();

    findByExternalId.mockResolvedValueOnce({ id: 10, bookingId: 20, success: false });
    const missingCredentials = createResponse();
    await webhook(buildRequest(body, { headers }), missingCredentials as unknown as NextApiResponse);
    expect(missingCredentials.status).toHaveBeenCalledWith(404);
    expect(missingCredentials.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Cal.diy: credentials not found" })
    );

    findByExternalId.mockResolvedValueOnce({
      id: 10,
      bookingId: 20,
      success: false,
      booking: { user: { credentials: [{ key: { serverUrl: SERVER_URL } }] } },
    });
    const invalidCredentials = createResponse();
    await webhook(buildRequest(body, { headers }), invalidCredentials as unknown as NextApiResponse);
    expect(invalidCredentials.status).toHaveBeenCalledWith(400);
    expect(invalidCredentials.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Cal.diy: Invalid BTCPay credentials" })
    );
  });
});
