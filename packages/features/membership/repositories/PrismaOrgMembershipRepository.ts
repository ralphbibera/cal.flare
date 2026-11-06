import { prisma } from "@calcom/prisma";
import { findManyInChunks } from "@calcom/prisma/d1";
import { MembershipRole } from "@calcom/prisma/enums";

export class PrismaOrgMembershipRepository {
  static async getOrgIdsWhereAdmin(loggedInUserId: number) {
    const loggedInUserOrgMemberships = await prisma.membership.findMany({
      where: {
        userId: loggedInUserId,
        role: {
          in: [MembershipRole.OWNER, MembershipRole.ADMIN],
        },
        team: {
          parentId: null,
        },
      },
      select: {
        teamId: true,
      },
    });

    return loggedInUserOrgMemberships.map((m) => m.teamId);
  }

  static async isLoggedInUserOrgAdminOfBookingHost(loggedInUserId: number, bookingUserId: number) {
    const orgIdsWhereLoggedInUserAdmin =
      await PrismaOrgMembershipRepository.getOrgIdsWhereAdmin(loggedInUserId);

    if (orgIdsWhereLoggedInUserAdmin.length === 0) {
      return false;
    }

    const bookingUserOrgMembership = await findManyInChunks(orgIdsWhereLoggedInUserAdmin, (chunk) =>
      prisma.membership.findMany({
        where: {
          userId: bookingUserId,
          teamId: {
            in: chunk,
          },
          team: {
            parentId: null,
          },
        },
        select: {
          userId: true,
        },
        take: 1,
      })
    );

    if (bookingUserOrgMembership.length > 0) return true;

    const bookingUserOrgTeamMembership = await findManyInChunks(orgIdsWhereLoggedInUserAdmin, (chunk) =>
      prisma.membership.findMany({
        where: {
          userId: bookingUserId,
          team: {
            parentId: {
              in: chunk,
            },
          },
        },
        select: {
          userId: true,
        },
        take: 1,
      })
    );

    return bookingUserOrgTeamMembership.length > 0;
  }
}
