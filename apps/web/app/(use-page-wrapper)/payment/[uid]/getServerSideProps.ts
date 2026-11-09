import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { shouldHideBrandingForEvent } from "@calcom/features/profile/lib/hideBranding";
import prisma from "@calcom/prisma";
import type { Payment } from "@calcom/prisma/client";
import { BookingStatus } from "@calcom/prisma/enums";
import { paymentDataSelect } from "@calcom/prisma/selects/payment";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import type { GetServerSidePropsContext } from "next";
import { z } from "zod";

const querySchema = z.object({
  uid: z.string(),
});

function hasStringProp<T extends string>(value: unknown, key: T): value is { [key in T]: string } {
  return !!value && typeof value === "object" && key in value;
}

function getClientSecretFromPayment(
  payment: Omit<Partial<Payment>, "data"> & { data: Record<string, unknown> }
) {
  if (
    payment.paymentOption === "HOLD" &&
    hasStringProp(payment.data, "setupIntent") &&
    hasStringProp(payment.data.setupIntent, "client_secret")
  ) {
    return payment.data.setupIntent.client_secret;
  }
  if (hasStringProp(payment.data, "client_secret")) {
    return payment.data.client_secret;
  }
  return "";
}

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const { uid } = querySchema.parse(context.query);
  const session = await getServerSession({ req: context.req });

  const rawPayment = await prisma.payment.findUnique({
    where: { uid },
    select: paymentDataSelect,
  });

  if (!rawPayment) return { notFound: true } as const;

  const { data, booking: rawBooking, ...restPayment } = rawPayment;
  const bookingEventType = rawBooking?.eventType;

  if (!rawBooking || !bookingEventType) return { notFound: true } as const;
  if (bookingEventType.users.length === 0 && !bookingEventType.team) return { notFound: true } as const;

  const { startTime, endTime, eventType: _eventType, ...restBooking } = rawBooking;
  const booking = {
    ...restBooking,
    startTime: startTime.toString(),
    endTime: endTime.toString(),
  };

  const [owner] = bookingEventType.users.length
    ? bookingEventType.users
    : [{ name: null, theme: null, hideBranding: null, username: null }];
  const profile = {
    name: bookingEventType.team?.name || owner?.name || null,
    theme: (!bookingEventType.team?.name && owner?.theme) || null,
    hideBranding: await shouldHideBrandingForEvent({
      eventTypeId: bookingEventType.id,
      team: bookingEventType.team,
      owner: bookingEventType.users[0] ?? null,
      organizationId: session?.user?.profile?.organizationId ?? session?.user?.org?.id ?? null,
    }),
  };

  if (
    ([BookingStatus.CANCELLED, BookingStatus.REJECTED] as BookingStatus[]).includes(
      booking.status as BookingStatus
    )
  ) {
    return {
      redirect: {
        destination: `/booking/${booking.uid}`,
        permanent: false,
      },
    };
  }

  const payment = {
    ...restPayment,
    data: data as Record<string, unknown>,
  };

  return {
    props: {
      user: owner,
      eventType: {
        ...bookingEventType,
        metadata: EventTypeMetaDataSchema.parse(bookingEventType.metadata),
      },
      booking,
      payment,
      clientSecret: getClientSecretFromPayment(payment),
      profile,
    },
  };
};
