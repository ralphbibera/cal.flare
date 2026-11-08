import { Request } from "express";

import type { Team } from "@calcom/prisma/client";

export interface UserContext {
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  teamId?: string;
  userOrgId?: string;
}

interface RequestUser {
  id: number | string;
  email: string;
  profiles?: readonly { organizationId?: number | null }[];
}

export function extractUserContext(request: Request): UserContext {
  const context: UserContext = {};

  const user = (request as Request & { user?: RequestUser }).user;
  if (user) {
    context.userId = String(user.id);
    context.userEmail = user.email;
    if (user.profiles?.[0]?.organizationId) {
      context.userOrgId = String(user.profiles?.[0].organizationId);
    }
  }

  const organizationId = (request as Request & { organizationId?: number }).organizationId;
  if (organizationId) {
    context.organizationId = String(organizationId);
  }

  const team = (request as Request & { team?: Team }).team;
  if (team) {
    context.teamId = String(team.id);
  }

  return context;
}
