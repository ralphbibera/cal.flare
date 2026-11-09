import type { GetServerSidePropsContext } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getServerSession: vi.fn(),
  shouldHideBrandingForEvent: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({
  default: { payment: { findUnique: mocks.findUnique } },
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@calcom/features/profile/lib/hideBranding", () => ({
  shouldHideBrandingForEvent: mocks.shouldHideBrandingForEvent,
}));

import { getServerSideProps } from "./getServerSideProps";

const startTime = new Date("2026-12-01T09:00:00.000Z");
const endTime = new Date("2026-12-01T09:30:00.000Z");

function paymentRow(overrides: { status?: string } = {}) {
  return {
    id: 1,
    data: { client_secret: "secret" },
    success: false,
    uid: "payment-uid",
    refunded: false,
    bookingId: 10,
    appId: "mock-payment-app",
    amount: 100,
    currency: "usd",
    paymentOption: null,
    booking: {
      id: 10,
      uid: "booking-uid",
      description: null,
      title: "30 min between Owner and Booker",
      startTime,
      endTime,
      responses: {},
      user: { name: "Owner", timeZone: "UTC" },
      attendees: [],
      eventTypeId: 20,
      location: null,
      status: overrides.status ?? "ACCEPTED",
      paid: false,
      rejectionReason: null,
      cancellationReason: null,
      eventType: {
        id: 20,
        title: "30 min",
        description: null,
        length: 30,
        eventName: null,
        requiresConfirmation: false,
        userId: 1,
        metadata: { apps: {} },
        users: [{ id: 1, name: "Owner", username: "owner", hideBranding: false, theme: null }],
        team: null,
        price: 100,
        currency: "usd",
        successRedirectUrl: null,
        forwardParamsSuccessRedirect: null,
      },
    },
  };
}

function context(uid = "payment-uid") {
  return { query: { uid }, req: {} } as unknown as GetServerSidePropsContext;
}

describe("payment page getServerSideProps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue(null);
    mocks.shouldHideBrandingForEvent.mockResolvedValue(false);
  });

  it("loads the booking, event type and payment for the page", async () => {
    mocks.findUnique.mockResolvedValue(paymentRow());

    const result = await getServerSideProps(context());

    expect(result).toMatchObject({
      props: {
        booking: {
          uid: "booking-uid",
          startTime: startTime.toString(),
          endTime: endTime.toString(),
        },
        payment: { id: 1, uid: "payment-uid", appId: "mock-payment-app", amount: 100 },
        eventType: { id: 20, length: 30, metadata: { apps: {} } },
        clientSecret: "secret",
        profile: { name: "Owner", hideBranding: false },
        user: { username: "owner" },
      },
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { uid: "payment-uid" },
      select: expect.objectContaining({ id: true, booking: expect.any(Object) }),
    });
  });

  it("returns not found when the payment does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(getServerSideProps(context())).resolves.toEqual({ notFound: true });
  });

  it("redirects a cancelled booking back to the booking page", async () => {
    mocks.findUnique.mockResolvedValue(paymentRow({ status: "CANCELLED" }));

    await expect(getServerSideProps(context())).resolves.toEqual({
      redirect: { destination: "/booking/booking-uid", permanent: false },
    });
  });
});
