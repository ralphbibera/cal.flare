import type { CalServerSession } from "@calcom/features/auth/lib/cal-server-session";
import { handleMarkAttendeesAndHostNoShow } from "@calcom/features/handleMarkNoShow";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TNoShowInputSchema } from "./markNoShow.schema";

type NoShowOptions = {
  input: TNoShowInputSchema;
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    session: CalServerSession;
  };
};

export const markNoShow = async ({ ctx, input }: NoShowOptions) => {
  const { bookingUid, attendees, noShowHost } = input;

  return handleMarkAttendeesAndHostNoShow({
    bookingUid,
    attendees,
    noShowHost,
    userId: ctx.user.id,
    locale: ctx.user.locale,
  });
};
