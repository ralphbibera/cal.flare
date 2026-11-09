import { WEBAPP_URL } from "@calcom/lib/constants";
import stripeWebhook from "@calcom/web/pages/api/integrations/stripepayment/webhook";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import callback from "../api/callback";
import { BuildPaymentService } from "../lib/PaymentService";

const APP_KEYS = {
  client_id: "ca_connect_client",
  client_secret: "sk_connect_secret",
  public_key: "pk_connect_public",
  webhook_secret: "whsec_connect_webhook",
};

const CREDENTIALS = {
  key: {
    stripe_user_id: "acct_connected",
    default_currency: "usd",
    stripe_publishable_key: "pk_live_connected",
  },
};

const { prisma, stripeClient, stripeServer, retrieveOrCreateStripeCustomerByEmail } = vi.hoisted(() => {
  return {
    prisma: {
      user: { findUnique: vi.fn(), update: vi.fn() },
      app: { findUnique: vi.fn() },
      credential: { create: vi.fn() },
      payment: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    },
    stripeClient: {
      paymentIntents: { create: vi.fn(), cancel: vi.fn() },
      setupIntents: { create: vi.fn() },
      customers: { retrieve: vi.fn(), list: vi.fn(), create: vi.fn() },
      paymentMethods: { retrieve: vi.fn() },
      refunds: { create: vi.fn() },
      checkout: { sessions: { list: vi.fn(), expire: vi.fn() } },
    },
    stripeServer: {
      oauth: { token: vi.fn() },
      accounts: { retrieve: vi.fn() },
    },
    retrieveOrCreateStripeCustomerByEmail: vi.fn(),
  };
});

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

vi.mock("stripe", () => ({
  default: class StripeMock {
    paymentIntents = stripeClient.paymentIntents;
    setupIntents = stripeClient.setupIntents;
    customers = stripeClient.customers;
    paymentMethods = stripeClient.paymentMethods;
    refunds = stripeClient.refunds;
    checkout = stripeClient.checkout;
  },
}));

vi.mock("../lib/server", () => ({ default: stripeServer }));

vi.mock("../lib/customer", () => ({ retrieveOrCreateStripeCustomerByEmail }));

vi.mock("@calcom/features/tasker", () => ({
  default: { create: vi.fn(), cancelWithReference: vi.fn() },
}));

vi.mock("@calcom/features/bookings/repositories/BookingRepository", () => ({
  BookingRepository: class {
    findByIdIncludeUserAndAttendees = vi.fn();
  },
}));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.redirect.mockReturnValue(res);
  res.end.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url: "/api/integrations/stripepayment/add",
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildService = () => BuildPaymentService(CREDENTIALS);

beforeEach(() => {
  vi.resetAllMocks();
  prisma.app.findUnique.mockResolvedValue({ keys: APP_KEYS });
  prisma.user.findUnique.mockResolvedValue({ email: "jane@example.com", name: "Jane" });
  prisma.credential.create.mockResolvedValue({ id: 3 });
  retrieveOrCreateStripeCustomerByEmail.mockResolvedValue({ id: "cus_booker" });
});

describe("Stripe Connect install", () => {
  it("sends the user to Stripe with the redirect URI and without the app secret", async () => {
    const res = createResponse();

    await add(buildRequest({ query: { state: "oauth-state" } }), res as unknown as NextApiResponse);

    const { url } = res.json.mock.calls[0][0] as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://connect.stripe.com/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(APP_KEYS.client_id);
    expect(authorize.searchParams.get("scope")).toBe("read_write");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${WEBAPP_URL}/api/integrations/stripepayment/callback`
    );
    expect(authorize.searchParams.get("state")).toBe("oauth-state");
    expect(authorize.searchParams.get("stripe_user[email]")).toBe("jane@example.com");
    expect(authorize.searchParams.get("stripe_user[first_name]")).toBe("Jane");
    expect(url).not.toContain(APP_KEYS.client_secret);
    expect(url).not.toContain(APP_KEYS.webhook_secret);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { email: true, name: true },
    });
  });

  it("exchanges the OAuth code, stores the Stripe account and redirects to the installed app", async () => {
    stripeServer.oauth.token.mockResolvedValue({
      access_token: "sk_live_access_token",
      token_type: "bearer",
      scope: "read_write",
      stripe_user_id: "acct_connected",
      stripe_publishable_key: "pk_live_connected",
    });
    stripeServer.accounts.retrieve.mockResolvedValue({ default_currency: "usd" });
    const res = createResponse();

    await callback(
      buildRequest({
        url: "/api/integrations/stripepayment/callback",
        query: { code: "oauth-code" },
      }),
      res as unknown as NextApiResponse
    );

    expect(stripeServer.oauth.token).toHaveBeenCalledWith({
      grant_type: "authorization_code",
      code: "oauth-code",
    });
    expect(stripeServer.accounts.retrieve).toHaveBeenCalledWith("acct_connected");

    const stored = prisma.credential.create.mock.calls[0][0] as {
      data: { type: string; appId: string; userId: number; key: Record<string, unknown> };
    };
    expect(stored.data).toMatchObject({ type: "stripe_payment", appId: "stripe", userId: 1 });
    expect(stored.data.key).toMatchObject({
      stripe_user_id: "acct_connected",
      stripe_publishable_key: "pk_live_connected",
      default_currency: "usd",
    });

    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/payment?hl=stripe");
    const responsePayload = JSON.stringify([...res.json.mock.calls, ...res.redirect.mock.calls]);
    expect(responsePayload).not.toContain("sk_live_access_token");
    expect(responsePayload).not.toContain(APP_KEYS.client_secret);
  });

  it("returns an OAuth denial to the installed page without storing a credential", async () => {
    const res = createResponse();

    await callback(
      buildRequest({
        url: "/api/integrations/stripepayment/callback",
        query: { error: "access_denied" },
      }),
      res as unknown as NextApiResponse
    );

    expect(res.redirect).toHaveBeenCalledWith("/apps/installed/payment");
    expect(stripeServer.oauth.token).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("rejects a callback without a session", async () => {
    const res = createResponse();

    await callback(
      buildRequest({
        url: "/api/integrations/stripepayment/callback",
        query: { code: "oauth-code" },
        session: undefined,
      }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "You must be logged in to do this" });
    expect(stripeServer.oauth.token).not.toHaveBeenCalled();
  });
});

describe("Stripe payment creation", () => {
  it("creates the payment intent with the booking metadata and stores the payment", async () => {
    stripeClient.paymentIntents.create.mockResolvedValue({ id: "pi_booking", amount: 2500 });
    prisma.payment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 11,
      ...data,
    }));

    const payment = await buildService().create(
      { amount: 2500, currency: "usd" },
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

    expect(retrieveOrCreateStripeCustomerByEmail).toHaveBeenCalledWith(
      "acct_connected",
      "alex@example.com",
      "+15551234567"
    );
    expect(stripeClient.paymentIntents.create).toHaveBeenCalledWith(
      {
        amount: 2500,
        currency: "usd",
        customer: "cus_booker",
        automatic_payment_methods: { enabled: true },
        metadata: {
          identifier: "cal.com",
          bookingId: 42,
          calAccountId: 7,
          calUsername: "jane",
          bookerName: "Alex",
          bookerEmail: "alex@example.com",
          bookerPhoneNumber: "+15551234567",
          eventTitle: "Consultation",
          bookingTitle: "Planning session",
        },
      },
      { stripeAccount: "acct_connected" }
    );

    const stored = prisma.payment.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(stored.data).toMatchObject({
      amount: 2500,
      currency: "usd",
      externalId: "pi_booking",
      app: { connect: { slug: "stripe" } },
      booking: { connect: { id: 42 } },
      fee: 0,
      refunded: false,
      success: false,
    });
    expect(stored.data.data).toMatchObject({
      id: "pi_booking",
      stripeAccount: "acct_connected",
      stripe_publishable_key: "pk_live_connected",
    });
    expect(payment).toMatchObject({ id: 11, externalId: "pi_booking" });
  });

  it("collects a card with a setup intent for the HOLD payment option", async () => {
    stripeClient.setupIntents.create.mockResolvedValue({ id: "seti_booking" });
    prisma.payment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 12,
      ...data,
    }));

    await buildService().collectCard(
      { amount: 5000, currency: "usd" },
      42,
      "HOLD",
      "alex@example.com",
      "+15551234567"
    );

    expect(stripeClient.setupIntents.create).toHaveBeenCalledWith(
      {
        customer: "cus_booker",
        payment_method_types: ["card"],
        metadata: { bookingId: 42, bookerPhoneNumber: "+15551234567" },
      },
      { stripeAccount: "acct_connected" }
    );
    const stored = prisma.payment.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(stored.data).toMatchObject({
      amount: 5000,
      currency: "usd",
      externalId: "seti_booking",
      paymentOption: "HOLD",
      success: false,
    });
    expect(stored.data.data).toMatchObject({
      setupIntent: { id: "seti_booking" },
      stripeAccount: "acct_connected",
      stripe_publishable_key: "pk_live_connected",
    });
  });

  it("refuses the ON_BOOKING option in collectCard", async () => {
    await expect(
      buildService().collectCard({ amount: 5000, currency: "usd" }, 42, "ON_BOOKING", "alex@example.com")
    ).rejects.toThrow("Stripe: Payment method could not be collected");
    expect(stripeClient.setupIntents.create).not.toHaveBeenCalled();
  });

  it("wraps a failed payment intent in the creation error", async () => {
    stripeClient.paymentIntents.create.mockRejectedValue(new Error("card_declined"));

    await expect(
      buildService().create(
        { amount: 2500, currency: "usd" },
        42,
        7,
        "jane",
        "Alex",
        "ON_BOOKING",
        "alex@example.com"
      )
    ).rejects.toThrow("payment_not_created_error");
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("rejects a service without parsed credentials", async () => {
    await expect(
      BuildPaymentService({ key: {} }).create(
        { amount: 2500, currency: "usd" },
        42,
        7,
        "jane",
        "Alex",
        "ON_BOOKING",
        "alex@example.com"
      )
    ).rejects.toThrow("payment_not_created_error");
  });
});

describe("Stripe refunds and cancellation", () => {
  it("refunds a successful payment on the connected account", async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 5,
      externalId: "pi_booking",
      success: true,
      refunded: false,
      data: { stripeAccount: "acct_connected" },
    });
    stripeClient.refunds.create.mockResolvedValue({ id: "re_1", status: "succeeded" });
    prisma.payment.update.mockResolvedValue({ id: 5, refunded: true });

    const result = await buildService().refund(5);

    expect(stripeClient.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_booking" },
      { stripeAccount: "acct_connected" }
    );
    expect(prisma.payment.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { refunded: true } });
    expect(result).toMatchObject({ refunded: true });
  });

  it("returns an already refunded payment without calling Stripe", async () => {
    const payment = {
      id: 5,
      externalId: "pi_booking",
      success: true,
      refunded: true,
      data: { stripeAccount: "acct_connected" },
    };
    prisma.payment.findFirst.mockResolvedValue(payment);

    await expect(buildService().refund(5)).resolves.toEqual(payment);
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
  });

  it("refuses to refund a failed payment", async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 5,
      externalId: "pi_booking",
      success: false,
      refunded: false,
      data: {},
    });

    await expect(buildService().refund(5)).rejects.toThrow("Unable to refund failed payment");
  });

  it("returns null when the payment does not exist", async () => {
    prisma.payment.findFirst.mockResolvedValue(null);

    await expect(buildService().refund(99)).resolves.toBeNull();
  });

  it("expires checkout sessions and cancels the payment intent", async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 5,
      externalId: "pi_booking",
      success: false,
      refunded: false,
      data: { stripeAccount: "acct_connected" },
    });
    stripeClient.checkout.sessions.list.mockResolvedValue({
      data: [{ id: "cs_1" }, { id: "cs_2" }],
    });
    stripeClient.checkout.sessions.expire.mockResolvedValue({});
    stripeClient.paymentIntents.cancel.mockResolvedValue({});

    await expect(buildService().deletePayment(5)).resolves.toBe(true);

    expect(stripeClient.checkout.sessions.list).toHaveBeenCalledWith(
      { payment_intent: "pi_booking" },
      { stripeAccount: "acct_connected" }
    );
    expect(stripeClient.checkout.sessions.expire).toHaveBeenNthCalledWith(1, "cs_1", {
      stripeAccount: "acct_connected",
    });
    expect(stripeClient.checkout.sessions.expire).toHaveBeenNthCalledWith(2, "cs_2", {
      stripeAccount: "acct_connected",
    });
    expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledWith("pi_booking", {
      stripeAccount: "acct_connected",
    });
  });

  it("reports a failed cancellation without throwing", async () => {
    prisma.payment.findFirst.mockResolvedValue({
      id: 5,
      externalId: "pi_booking",
      success: false,
      refunded: false,
      data: {},
    });

    await expect(buildService().deletePayment(5)).resolves.toBe(false);
    expect(stripeClient.paymentIntents.cancel).not.toHaveBeenCalled();
  });
});

describe("Stripe community edition webhook", () => {
  it("keeps the Stripe payment webhook disabled", () => {
    const res = createResponse();

    stripeWebhook({} as NextApiRequest, res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      message: "Payment webhooks are not available in community edition",
    });
  });
});
