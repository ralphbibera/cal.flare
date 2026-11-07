import process from "node:process";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { isPasswordValid } from "@calcom/lib/auth/isPasswordValid";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import { isENVDev } from "@calcom/lib/env";
import logger from "@calcom/lib/logger";
import { hashEmail } from "@calcom/lib/server/PiiHasher";
import prisma from "@calcom/prisma";
import { IdentityProvider, UserPermissionRole } from "@calcom/prisma/enums";
import { checkIfUserBelongsToActiveTeam } from "./checkIfUserBelongsToActiveTeam";
import { ErrorCode } from "./ErrorCode";
import type { CredentialPolicy } from "./request-context";
import { verifyPassword } from "./verifyPassword";

type UserWithProfiles = NonNullable<
  Awaited<ReturnType<UserRepository["findByEmailAndIncludeProfilesAndPassword"]>>
>;

const AdapterUserPresenter = {
  fromCalUser: (
    user: UserWithProfiles,
    role: UserPermissionRole | "INACTIVE_ADMIN",
    hasActiveTeams: boolean
  ) => ({
    ...user,
    role,
    belongsToActiveTeam: hasActiveTeams,
    profile: user.allProfiles[0],
  }),
};

type AuthorizedCredentialsUser = ReturnType<typeof AdapterUserPresenter.fromCalUser> & {
  inactiveAdminReason?: "both" | "password" | "2fa";
};

const log = logger.getSubLogger({ prefix: ["authorizeCredentials"] });

export async function authorizeCredentials(
  credentials: Record<"email" | "password" | "totpCode" | "backupCode", string> | undefined
): Promise<AuthorizedCredentialsUser> {
  return authorizeCredentialsForRequest(credentials);
}

export async function authorizeCredentialsForRequest(
  credentials: Parameters<typeof authorizeCredentials>[0],
  policy?: CredentialPolicy
): Promise<AuthorizedCredentialsUser> {
  log.debug("CredentialsProvider:credentials:authorize");
  if (!credentials) {
    console.error(`For some reason credentials are missing`);
    throw new Error(ErrorCode.InternalServerError);
  }

  const encryptionKey = policy ? policy.encryptionKey : process.env.CALENDSO_ENCRYPTION_KEY;

  const userRepo = new UserRepository(prisma);
  const user = await userRepo.findByEmailAndIncludeProfilesAndPassword({
    email: credentials.email,
  });
  // Don't leak information about it being username or password that is invalid
  if (!user) {
    throw new Error(ErrorCode.IncorrectEmailPassword);
  }

  // Locked users cannot login
  if (user.locked) {
    throw new Error(ErrorCode.UserAccountLocked);
  }

  if (policy?.rateLimit !== "disabled") {
    await checkRateLimitAndThrowError({
      identifier: hashEmail(user.email),
    });
  }

  // Users without a password must use their identity provider (Google/SAML) to login
  if (!user.password?.hash) {
    throw new Error(ErrorCode.IncorrectEmailPassword);
  }

  // Always verify password for users who have one
  const isCorrectPassword = await verifyPassword(credentials.password, user.password.hash);
  if (!isCorrectPassword) {
    throw new Error(ErrorCode.IncorrectEmailPassword);
  }

  if (user.twoFactorEnabled && credentials.backupCode) {
    if (!encryptionKey) {
      console.error("Missing encryption key; cannot proceed with backup code login.");
      throw new Error(ErrorCode.InternalServerError);
    }

    if (!user.backupCodes) throw new Error(ErrorCode.MissingBackupCodes);

    const backupCodes = JSON.parse(symmetricDecrypt(user.backupCodes, encryptionKey));

    // check if user-supplied code matches one
    const index = backupCodes.indexOf(credentials.backupCode.replaceAll("-", ""));
    if (index === -1) throw new Error(ErrorCode.IncorrectBackupCode);

    // delete verified backup code and re-encrypt remaining
    backupCodes[index] = null;
    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        backupCodes: symmetricEncrypt(JSON.stringify(backupCodes), encryptionKey),
      },
    });
  } else if (user.twoFactorEnabled) {
    if (!credentials.totpCode) {
      throw new Error(ErrorCode.SecondFactorRequired);
    }

    if (!user.twoFactorSecret) {
      console.error(`Two factor is enabled for user ${user.id} but they have no secret`);
      throw new Error(ErrorCode.InternalServerError);
    }

    if (!encryptionKey) {
      console.error(`"Missing encryption key; cannot proceed with two factor login."`);
      throw new Error(ErrorCode.InternalServerError);
    }

    const secret = symmetricDecrypt(user.twoFactorSecret, encryptionKey);
    if (secret.length !== 32) {
      console.error(
        `Two factor secret decryption failed. Expected key with length 32 but got ${secret.length}`
      );
      throw new Error(ErrorCode.InternalServerError);
    }

    const isValidToken = (await import("@calcom/lib/totp")).totpAuthenticatorCheck(
      credentials.totpCode,
      secret
    );
    if (!isValidToken) {
      throw new Error(ErrorCode.IncorrectTwoFactorCode);
    }
  }
  // Check if the user you are logging into has any active teams
  const hasActiveTeams = checkIfUserBelongsToActiveTeam(user);

  // authentication success- but does it meet the minimum password requirements?
  const validateRole = (role: UserPermissionRole) => {
    // User's role is not "ADMIN"
    if (role !== UserPermissionRole.ADMIN) return role;
    // User's identity provider is not "CAL"
    if (user.identityProvider !== IdentityProvider.CAL) return role;

    if (policy ? policy.isE2E : process.env.NEXT_PUBLIC_IS_E2E) {
      console.warn("E2E testing is enabled, skipping password and 2FA requirements for Admin");
      return role;
    }

    // User's password is valid and two-factor authentication is enabled
    if (isPasswordValid(credentials.password, false, true) && user.twoFactorEnabled) return role;
    // Code is running in a development environment
    if (policy ? policy.isDevelopment : isENVDev) return role;
    // By this point it is an ADMIN without valid security conditions
    return "INACTIVE_ADMIN";
  };

  const role = validateRole(user.role);
  const baseUser = AdapterUserPresenter.fromCalUser(user, role, hasActiveTeams);

  if (role === "INACTIVE_ADMIN") {
    const passwordValid = isPasswordValid(credentials.password, false, true);
    const has2FA = user.twoFactorEnabled;

    let reason: "both" | "password" | "2fa";

    if (!passwordValid && !has2FA) {
      reason = "both";
    } else if (!passwordValid) {
      reason = "password";
    } else {
      reason = "2fa";
    }

    return { ...baseUser, inactiveAdminReason: reason };
  }

  return baseUser;
}
