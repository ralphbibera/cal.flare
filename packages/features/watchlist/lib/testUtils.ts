import { prisma } from "@calcom/prisma";
import type { WatchlistType } from "@calcom/prisma/enums";

interface WatchlistInput {
  type: WatchlistType;
  value: string;
}

export const createWatchlistEntry = async (input: WatchlistInput) => {
  await prisma.watchlist.create({
    data: {
      ...input,
    },
  });
};
