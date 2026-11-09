import { beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import { BuildPaymentService } from "../lib/PaymentService";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    credential: { create: vi.fn() },
    booking: { findUnique: vi.fn() },
    payment: { create: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("uuid", () => ({ v4: () => "payment-uid" }));

const buildService = () => BuildPaymentService({ key: {} });

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.create.mockResolvedValue({ id: 3 });
  prisma.booking.findUnique.mockResolvedValue({ uid: "booking-uid", title: "Paid event" });
  prisma.payment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 10,
    ...data,
  }));
});

describe("Mock payment app install", () => {
  it("creates the default credential without provider secrets", async () => {
    prisma.credential.create.mockResolvedValue({ id: 3 });

    const credential = await add.createCredential?.({
      appType: add.appType,
      user: { id: 1 },
      slug: add.slug,
    });

    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "mock-payment-app_payment",
        key: {},
        userId: 1,
        appId: "mock-payment-app",
      }),
    });
    expect(credential).toMatchObject({ id: 3 });
    expect(add).toMatchObject({
      appType: "mock-payment-app_payment",
      variant: "payment",
      slug: "mock-payment-app",
      supportsMultipleInstalls: false,
    });
  });
});

describe("Mock payment creation", () => {
  it("stores a payment for the booking without contacting a provider", async () => {
    const payment = await buildService().create({ amount: 2500, currency: "usd" }, 42);

    expect(prisma.booking.findUnique).toHaveBeenCalledWith({
      select: { uid: true, title: true },
      where: { id: 42 },
    });
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: {
        uid: "payment-uid",
        app: { connect: { slug: "mock-payment-app" } },
        booking: { connect: { id: 42 } },
        amount: 2500,
        externalId: "payment-uid",
        currency: "usd",
        data: {},
        fee: 0,
        refunded: false,
        success: false,
      },
    });
    expect(payment).toMatchObject({ id: 10, uid: "payment-uid", externalId: "payment-uid" });
  });

  it("returns the creation error when the booking does not exist", async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    await expect(buildService().create({ amount: 2500, currency: "usd" }, 42)).rejects.toThrow(
      "Payment could not be created"
    );
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("reports the app as set up without provider credentials and has no refund or cancel path", async () => {
    const service = buildService();

    expect(service.isSetupAlready()).toBe(true);
    await expect(service.refund()).rejects.toThrow("Method not implemented.");
    await expect(service.deletePayment()).resolves.toBe(false);
  });
});
