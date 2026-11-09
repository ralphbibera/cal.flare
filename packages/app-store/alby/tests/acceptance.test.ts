import { Readable } from "node:stream";
import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import type { NextApiRequest, NextApiResponse } from "next";
import { Webhook as SvixWebhook } from "svix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import webhook from "../api/webhook";
import { BuildPaymentService } from "../lib/PaymentService";

const LIGHTNING_ADDRESS = "alice@getalby.com";
const WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PAYMENT_REQUEST = "lnbc10u1p3paymentrequest";
const CREDENTIALS = {
  key: {
    account_id: "account-1",
    account_email: "alice@example.com",
    account_lightning_address: LIGHTNING_ADDRESS,
    webhook_endpoint_id: "endpoint-1",
    webhook_endpoint_secret: WEBHOOK_SECRET,
  },
};

const { prisma, handlePaymentSuccessMock, requestInvoice, LightningAddress } = vi.hoisted(() => ({
  prisma: {
    credential: { findFirst: vi.fn(), create: vi.fn() },
    booking: { findUnique: vi.fn() },
    payment: { findFirst: vi.fn(), create: vi.fn() },
  },
  handlePaymentSuccessMock: vi.fn(),
  requestInvoice: vi.fn(),
  LightningAddress: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: handlePaymentSuccessMock,
}));

vi.mock("@getalby/lightning-tools", () => ({
  LightningAddress: class {
    constructor(address: string) {
      LightningAddress(address);
    }
    fetch = vi.fn().mockResolvedValue(undefined);
    requestInvoice = requestInvoice;
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
    url: "/api/integrations/alby/webhook",
    ...overrides,
  }) as unknown as NextApiRequest;

const buildCatalogRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url: "/api/integrations/alby/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildService = () => BuildPaymentService(CREDENTIALS);

const invoicePayload = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "invoice-1",
    amount: 1000,
    metadata: {
      payer_data: {
        appId: "cal.com",
        referenceId: "payment-uid",
      },
    },
    ...overrides,
  });

const sign = (body: string, messageId = "msg_1") => {
  const timestamp = new Date();
  const signature = new SvixWebhook(WEBHOOK_SECRET).sign(messageId, timestamp, body);
  return {
    "svix-id": messageId,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": signature,
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 3 });
  prisma.booking.findUnique.mockResolvedValue({ uid: "booking-uid", title: "Paid event" });
  prisma.payment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 10,
    ...data,
  }));
  requestInvoice.mockResolvedValue({ paymentRequest: PAYMENT_REQUEST, paymentHash: "hash-1" });
  handlePaymentSuccessMock.mockResolvedValue({ ok: true });
});

describe("Alby install", () => {
  it("creates an empty credential and points the user at the setup page", async () => {
    const res = createResponse();

    await add(buildCatalogRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "alby_payment", key: {}, userId: 1, appId: "alby" },
    });
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/alby/setup" });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(WEBHOOK_SECRET);
  });

  it("refuses a second install and unauthenticated requests", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 3 });
    const res = createResponse();

    await add(buildCatalogRequest(), res as unknown as NextApiResponse);
    expect(res.json).toHaveBeenCalledWith({ message: "Already installed" });
    expect(prisma.credential.create).not.toHaveBeenCalled();

    const unauthRes = createResponse();
    await add(buildCatalogRequest({ session: undefined }), unauthRes as unknown as NextApiResponse);
    expect(unauthRes.status).toHaveBeenCalledWith(401);
    expect(unauthRes.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
  });
});

describe("Alby payment creation", () => {
  it("requests a lightning invoice for the booking amount and stores it", async () => {
    const payment = await buildService().create({ amount: 1000, currency: "BTC" }, 42);

    expect(LightningAddress).toHaveBeenCalledWith(LIGHTNING_ADDRESS);
    const stored = prisma.payment.create.mock.calls[0][0] as {
      data: { uid: string; [key: string]: unknown };
    };
    expect(requestInvoice).toHaveBeenCalledWith({
      satoshi: 1000,
      payerdata: { appId: "cal.com", referenceId: stored.data.uid },
    });
    expect(stored.data).toMatchObject({
      amount: 1000,
      currency: "BTC",
      externalId: PAYMENT_REQUEST,
      app: { connect: { slug: "alby" } },
      booking: { connect: { id: 42 } },
      fee: 0,
      refunded: false,
      success: false,
    });
    expect(stored.data.data).toEqual({
      invoice: { paymentRequest: PAYMENT_REQUEST, paymentHash: "hash-1", isPaid: false },
    });
    expect(payment).toMatchObject({ id: 10, externalId: PAYMENT_REQUEST });
    expect(JSON.stringify(stored.data)).not.toContain(WEBHOOK_SECRET);
  });

  it("returns a creation error when the booking or lightning address is missing", async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    await expect(buildService().create({ amount: 1000, currency: "BTC" }, 42)).rejects.toThrow(
      "payment_not_created_error"
    );
    expect(requestInvoice).not.toHaveBeenCalled();

    prisma.booking.findUnique.mockResolvedValue({ uid: "booking-uid", title: "Paid event" });
    await expect(
      BuildPaymentService({ key: { ...CREDENTIALS.key, account_lightning_address: "" } }).create(
        { amount: 1000, currency: "BTC" },
        42
      )
    ).rejects.toThrow("payment_not_created_error");
  });

  it("does not implement card collection, refunds or cancellation", async () => {
    const service = buildService();

    await expect(
      service.collectCard({ amount: 1000, currency: "BTC" }, 42, "alex@example.com", "ON_BOOKING")
    ).rejects.toThrow("Method not implemented");
    await expect(service.refund()).rejects.toThrow("Method not implemented.");
    await expect(service.deletePayment()).resolves.toBe(false);
  });
});

describe("Alby webhook", () => {
  beforeEach(() => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 10,
      amount: 1000,
      bookingId: 20,
      booking: { user: { credentials: [{ key: CREDENTIALS.key }] } },
    });
  });

  it("verifies the svix signature and confirms the booking", async () => {
    const body = invoicePayload();
    const res = createResponse();

    await webhook(buildRequest(body, { headers: sign(body) }), res as unknown as NextApiResponse);

    expect(prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { uid: "payment-uid" },
      select: {
        id: true,
        amount: true,
        bookingId: true,
        booking: {
          select: {
            user: {
              select: {
                credentials: { where: { type: "alby_payment" } },
              },
            },
          },
        },
      },
    });
    expect(handlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 10, bookingId: 20, appSlug: "alby" })
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it("rejects an invoice whose signature does not match", async () => {
    const body = invoicePayload();
    const headers = sign(body);
    const res = createResponse();

    await webhook(
      buildRequest(body, {
        headers: { ...headers, "svix-signature": headers["svix-signature"].replace(/.$/, "x") },
      }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Invoice not found" }));
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("rejects a signed invoice for a different amount", async () => {
    const body = invoicePayload({ amount: 999 });
    const res = createResponse();

    await webhook(buildRequest(body, { headers: sign(body) }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "invoice amount does not match payment amount" })
    );
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("ignores invoices that are not for cal.com", async () => {
    const body = invoicePayload({
      metadata: { payer_data: { appId: "other-app", referenceId: "payment-uid" } },
    });
    const res = createResponse();

    await webhook(buildRequest(body, { headers: sign(body) }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Payment not for cal.com" }));
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
  });

  it("reports missing payments, credentials and malformed credentials", async () => {
    const missingPayment = createResponse();
    prisma.payment.findFirst.mockResolvedValueOnce(null);
    await webhook(
      buildRequest(invoicePayload(), { headers: sign(invoicePayload()) }),
      missingPayment as unknown as NextApiResponse
    );
    expect(missingPayment.status).toHaveBeenCalledWith(204);
    expect(missingPayment.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Payment not found" })
    );

    const missingCredential = createResponse();
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 10,
      amount: 1000,
      bookingId: 20,
      booking: { user: {} },
    });
    await webhook(
      buildRequest(invoicePayload(), { headers: sign(invoicePayload()) }),
      missingCredential as unknown as NextApiResponse
    );
    expect(missingCredential.status).toHaveBeenCalledWith(204);
    expect(missingCredential.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Credentials not found" })
    );

    const emptyCredentialList = createResponse();
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 10,
      amount: 1000,
      bookingId: 20,
      booking: { user: { credentials: [] } },
    });
    await webhook(
      buildRequest(invoicePayload(), { headers: sign(invoicePayload()) }),
      emptyCredentialList as unknown as NextApiResponse
    );
    // The lookup indexes [0] without guarding an empty credential list.
    expect(emptyCredentialList.status).toHaveBeenCalledWith(500);

    const malformed = createResponse();
    prisma.payment.findFirst.mockResolvedValueOnce({
      id: 10,
      amount: 1000,
      bookingId: 20,
      booking: { user: { credentials: [{ key: { account_id: "only" } }] } },
    });
    await webhook(
      buildRequest(invoicePayload(), { headers: sign(invoicePayload()) }),
      malformed as unknown as NextApiResponse
    );
    expect(malformed.status).toHaveBeenCalledWith(500);
    expect(malformed.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Credentials not valid" })
    );
  });

  it("rejects missing headers, malformed payloads and non-POST requests", async () => {
    const missingHeaders = createResponse();
    await webhook(buildRequest(invoicePayload()), missingHeaders as unknown as NextApiResponse);
    expect(missingHeaders.status).toHaveBeenCalledWith(400);
    expect(missingHeaders.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Bad Request" }));

    const malformed = createResponse();
    await webhook(
      buildRequest("{not-json", { headers: sign("{not-json") }),
      malformed as unknown as NextApiResponse
    );
    expect(malformed.status).toHaveBeenCalledWith(500);

    const wrongMethod = createResponse();
    await webhook(
      buildRequest(invoicePayload(), { method: "GET", headers: sign(invoicePayload()) }),
      wrongMethod as unknown as NextApiResponse
    );
    expect(wrongMethod.status).toHaveBeenCalledWith(405);
    expect(wrongMethod.send).toHaveBeenCalledWith(expect.objectContaining({ message: "Method Not Allowed" }));
  });
});
