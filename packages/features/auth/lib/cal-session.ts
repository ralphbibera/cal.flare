import { z } from "zod";
import type { authorizeCredentials } from "./authorizeCredentials";

const permissionRole = z.enum(["USER", "ADMIN"]);
const role = permissionRole.or(z.literal("INACTIVE_ADMIN"));
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const calClaimsSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  email: z.string(),
  image: z.string().nullable().optional(),
  role: role.nullable().optional(),
  orgAwareUsername: z.string().nullable().optional(),
  belongsToActiveTeam: z.boolean().optional(),
  locale: z.string().nullable().optional(),
  inactiveAdminReason: z.enum(["both", "password", "2fa"]).optional(),
  impersonatedBy: z
    .object({ id: z.number().int().positive(), uuid: z.string(), role: permissionRole })
    .optional(),
  org: z
    .object({
      id: z.number().int().positive(),
      name: z.string().optional(),
      slug: z.string(),
      logoUrl: z.string().nullable().optional(),
      fullDomain: z.string(),
      domainSuffix: z.string(),
      role: z.enum(["MEMBER", "ADMIN", "OWNER"]),
    })
    .nullable()
    .optional(),
});

export const profileContextSchema = z.object({
  profileId: z.number().int().positive().nullable(),
  upId: z.string().nullable(),
});

export type CalClaims = z.infer<typeof calClaimsSchema>;
export type CalProfileContext = z.infer<typeof profileContextSchema>;

export function credentialSession(user: Awaited<ReturnType<typeof authorizeCredentials>>) {
  return {
    claims: calClaimsSchema.parse({
      id: user.id,
      name: user.name,
      username: user.username,
      orgAwareUsername: user.username,
      email: user.email,
      role: user.role,
      belongsToActiveTeam: user.belongsToActiveTeam,
      locale: user.locale,
      inactiveAdminReason: user.inactiveAdminReason,
    }),
    profile: profileContextSchema.parse({
      profileId: user.profile?.id ?? null,
      upId: user.profile?.upId ?? null,
    }),
  };
}

export function sessionExpiresAt(sessionTimeout: number | undefined, now = Date.now()) {
  return new Date(now + (sessionTimeout ? sessionTimeout * 60 : SESSION_MAX_AGE) * 1000);
}

export function browserSession(claims: CalClaims, profile: CalProfileContext, now = Date.now()) {
  const { id, name, email, image, ...fields } = claims;
  return {
    expires: new Date(now + SESSION_MAX_AGE * 1000).toISOString(),
    profileId: profile.profileId,
    upId: profile.upId,
    hasValidLicense: false,
    user: { id, name, email, image, ...fields },
  };
}
