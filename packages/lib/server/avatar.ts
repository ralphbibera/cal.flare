import { prisma } from "@calcom/prisma";
import { v4 as uuidv4 } from "uuid";

export const uploadAvatar = async ({ userId, avatar: data }: { userId: number; avatar: string }) => {
  // sharp cannot load in workerd, so only load it for the SVG branch that needs it.
  const processedData = data.startsWith("data:image/svg+xml")
    ? await (await import("./imageUtils")).convertSvgToPng(data)
    : data;

  // Check if avatar already exists to preserve the objectKey
  const existing = await prisma.avatar.findUnique({
    where: {
      teamId_userId_isBanner: {
        teamId: 0,
        userId,
        isBanner: false,
      },
    },
    select: { objectKey: true },
  });

  const objectKey = existing?.objectKey ?? uuidv4();

  await prisma.avatar.upsert({
    where: {
      teamId_userId_isBanner: {
        teamId: 0,
        userId,
        isBanner: false,
      },
    },
    create: {
      userId: userId,
      data: processedData,
      objectKey,
      isBanner: false,
    },
    update: {
      data: processedData,
      // Don't update objectKey - keep existing to preserve URLs
    },
  });

  return `/api/avatar/${objectKey}.png`;
};

export const uploadLogo = async ({
  teamId,
  logo: data,
  isBanner = false,
}: {
  teamId: number;
  logo: string;
  isBanner?: boolean;
}): Promise<string> => {
  const objectKey = uuidv4();
  const processedData = data.startsWith("data:image/svg+xml")
    ? await (await import("./imageUtils")).convertSvgToPng(data)
    : data;

  await prisma.avatar.upsert({
    where: {
      teamId_userId_isBanner: {
        teamId,
        userId: 0,
        isBanner,
      },
    },
    create: {
      teamId,
      data: processedData,
      objectKey,
      isBanner,
    },
    update: {
      data: processedData,
      objectKey,
    },
  });

  return `/api/avatar/${objectKey}.png`;
};
