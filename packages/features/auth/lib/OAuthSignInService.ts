import process from "node:process";
import { updateProfilePhotoGoogle } from "@calcom/app-store/_utils/oauth/updateProfilePhotoGoogle";
import { updateProfilePhotoMicrosoft } from "@calcom/app-store/_utils/oauth/updateProfilePhotoMicrosoft";
import { createGoogleCalendarServiceWithGoogleType } from "@calcom/app-store/googlecalendar/lib/CalendarService";
import { findUserIdByInsensitiveField } from "@calcom/features/auth/lib/findUserIdByInsensitiveField";
import { getIdentityProvider } from "@calcom/features/auth/lib/identityProviders";
import { CredentialRepository } from "@calcom/features/credentials/repositories/CredentialRepository";
import { buildCredentialCreateData } from "@calcom/features/credentials/services/CredentialDataService";
import { GOOGLE_CALENDAR_SCOPES, MICROSOFT_CALENDAR_SCOPES } from "@calcom/lib/constants";
import logger from "@calcom/lib/logger";
import { randomString } from "@calcom/lib/random";
import { safeStringify } from "@calcom/lib/safeStringify";
import slugify from "@calcom/lib/slugify";
import prisma from "@calcom/prisma";
import { CreationSource, IdentityProvider, MembershipRole } from "@calcom/prisma/enums";
import { calendar_v3 } from "@googleapis/calendar";
import { OAuth2Client } from "googleapis-common";
import { z } from "zod";
import { getOrgUsernameFromEmail } from "../signup/utils/getOrgUsernameFromEmail";

const log = logger.getSubLogger({ prefix: ["OAuthSignInService"] });

export type OAuthAccount = {
  provider: string;
  providerAccountId: string;
  type: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  session_state?: string;
};

export type OAuthUser = {
  id: string | number;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
};

// Providers disagree on shape: Google sends a boolean `email_verified`, Azure AD sends `xms_edov`
// as a boolean for work/school accounts and as "1" for personal ones. A malformed claim reads as absent.
export const oauthProfileSchema = z.object({
  email_verified: z.boolean().optional().catch(undefined),
  xms_edov: z.union([z.boolean(), z.string(), z.number()]).optional().catch(undefined),
});
export type OAuthProfile = z.infer<typeof oauthProfileSchema>;

export type OAuthSignInDecision =
  | { kind: "allow"; userId: number }
  | { kind: "redirect"; to: string }
  | { kind: "deny" };

const allow = (userId: number): OAuthSignInDecision => ({ kind: "allow", userId });
const redirect = (to: string): OAuthSignInDecision => ({ kind: "redirect", to });
const deny: OAuthSignInDecision = { kind: "deny" };

const ORGANIZATIONS_AUTOLINK =
  process.env.ORGANIZATIONS_AUTOLINK === "1" || process.env.ORGANIZATIONS_AUTOLINK === "true";

const usernameSlug = (username: string) => `${slugify(username)}-${randomString(6).toLowerCase()}`;
const getDomainFromEmail = (email: string): string => email.split("@")[1];

const loginWithTotp = async (email: string) =>
  `/auth/login?totp=${encodeURIComponent(await (await import("./signJwt")).default({ email }))}`;

const checkIfUserShouldBelongToOrg = async (idP: IdentityProvider, email: string) => {
  const [orgUsername, apexDomain] = email.split("@");
  if (!ORGANIZATIONS_AUTOLINK || (idP !== "GOOGLE" && idP !== "AZUREAD"))
    return { orgUsername, orgId: undefined };
  const existingOrg = await prisma.team.findFirst({
    where: {
      organizationSettings: {
        isOrganizationVerified: true,
        orgAutoAcceptEmail: apexDomain,
      },
    },
    select: {
      id: true,
    },
  });
  return { orgUsername, orgId: existingOrg?.id };
};

const GOOGLE_API_CREDENTIALS = () => JSON.parse(process.env.GOOGLE_API_CREDENTIALS || "{}")?.web || {};

export class OAuthSignInService {
  async linkAccount(account: OAuthAccount, userId: number) {
    await prisma.account.create({
      data: {
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        type: account.type,
        user: { connect: { id: userId } },
        access_token: account.access_token,
        refresh_token: account.refresh_token,
        expires_at: account.expires_at,
        token_type: account.token_type,
        scope: account.scope,
        id_token: account.id_token,
        session_state: account.session_state,
      },
      select: { id: true },
    });
  }

  async signIn({
    user,
    account,
    profile,
  }: {
    user: OAuthUser;
    account: OAuthAccount;
    profile?: OAuthProfile;
  }): Promise<OAuthSignInDecision> {
    if (!user.email) {
      log.warn("callbacks:signIn - user email is missing", { provider: account?.provider });
      return deny;
    }

    if (!user.name) {
      log.warn("callbacks:signIn - user name is missing", {
        emailDomain: user.email.split("@")[1],
        provider: account?.provider,
      });
      return deny;
    }
    if (account?.provider) {
      const idP = getIdentityProvider(account.provider);

      if (!idP) {
        log.warn("callbacks:signIn - unknown provider, rejecting login", {
          provider: account.provider,
        });
        return redirect("/auth/error?error=unknown-provider");
      }
      // Use optional chaining for safety, especially with AdapterUser potentially having different structure initially.
      const isEmailVerified = user.emailVerified || profile?.email_verified;

      // For Azure AD, check xms_edov (Email Domain Owner Verified) claim
      // xms_edov returns inconsistent types: boolean for work/school, string "1" for personal accounts
      const xmsEdov = profile?.xms_edov;
      const isAzureEmailDomainVerified =
        xmsEdov === true || xmsEdov === "true" || xmsEdov === "1" || xmsEdov === 1;

      // Azure AD never sets email_verified in the token profile, so isEmailVerified is always
      // falsy for AZUREAD logins. Use isAzureEmailDomainVerified (xms_edov) as the equivalent
      // proof of ownership so the auto-merge path treats Azure AD the same as other verified IdPs.
      const isVerified = isEmailVerified || (idP === IdentityProvider.AZUREAD && isAzureEmailDomainVerified);

      if (idP === IdentityProvider.AZUREAD && !isAzureEmailDomainVerified) {
        log.error(
          "Azure AD email domain not verified (xms_edov claim)",
          safeStringify({ emailDomain: user.email?.split("@")[1], xmsEdov })
        );
        return redirect("/auth/error?error=unverified-email");
      }

      if (!isEmailVerified && idP !== IdentityProvider.AZUREAD) {
        log.error("Attention: SAML/Google User email is not verified in the IdP", safeStringify({ user }));
        return redirect("/auth/error?error=unverified-email");
      }

      const existingUserId = await findUserIdByInsensitiveField({
        where: { identityProvider: idP },
        field: "identityProviderId",
        value: account.providerAccountId,
      });
      let existingUser = existingUserId
        ? await prisma.user.findFirst({
            select: {
              id: true,
              email: true,
              twoFactorEnabled: true,
              identityProvider: true,
              accounts: {
                select: { id: true },
                where: {
                  provider: account.provider,
                },
              },
            },
            where: { id: existingUserId },
          })
        : null;

      /* --- START FIX LEGACY ISSUE WHERE 'identityProviderId' was accidentally set to userId --- */
      if (!existingUser) {
        existingUser = await prisma.user.findFirst({
          select: {
            id: true,
            email: true,
            twoFactorEnabled: true,
            identityProvider: true,
            accounts: {
              select: { id: true },
              where: {
                provider: account.provider,
              },
            },
          },
          where: {
            identityProvider: idP,
            identityProviderId: String(user.id),
          },
        });
        if (existingUser) {
          await prisma.user.update({
            where: {
              id: existingUser?.id,
            },
            data: {
              identityProviderId: account.providerAccountId,
            },
          });
        }
      }
      /* --- END FIXES LEGACY ISSUE WHERE 'identityProviderId' was accidentally set to userId --- */
      if (existingUser) {
        // In this case there's an existing user and their email address
        // hasn't changed since they last logged in.
        if (existingUser.email === user.email) {
          try {
            // If old user without Account entry we link their google account
            if (existingUser.accounts.length === 0) {
              await this.linkAccount(account, existingUser.id);
            }
          } catch (error) {
            if (error instanceof Error) {
              log.error("Error while linking account of already existing user", safeStringify(error));
            }
          }
          if (existingUser.twoFactorEnabled && existingUser.identityProvider === idP) {
            return redirect(await loginWithTotp(existingUser.email));
          } else {
            return allow(existingUser.id);
          }
        }

        // If the email address doesn't match, check if an account already exists
        // with the new email address. If it does, for now we return an error. If
        // not, update the email of their account and log them in.
        const userWithNewEmail = await prisma.user.findFirst({
          where: { email: user.email },
        });

        if (!userWithNewEmail) {
          await prisma.user.update({ where: { id: existingUser.id }, data: { email: user.email } });
          if (existingUser.twoFactorEnabled) {
            return redirect(await loginWithTotp(existingUser.email));
          } else {
            return allow(existingUser.id);
          }
        } else {
          return redirect("/auth/error?error=new-email-conflict");
        }
      }

      // If there's no existing user for this identity provider and id, create
      // a new account. If an account already exists with the incoming email
      // address return an error for now.

      const existingUserWithEmailId = await findUserIdByInsensitiveField({
        field: "email",
        value: user.email,
      });
      const existingUserWithEmail = existingUserWithEmailId
        ? await prisma.user.findFirst({
            where: { id: existingUserWithEmailId },
            select: {
              id: true,
              email: true,
              emailVerified: true,
              username: true,
              twoFactorEnabled: true,
              identityProvider: true,
              password: {
                select: {
                  hash: true,
                },
              },
            },
          })
        : null;

      if (existingUserWithEmail) {
        // if self-hosted then we can allow auto-merge of identity providers if email is verified
        if (isVerified && existingUserWithEmail.identityProvider !== IdentityProvider.CAL) {
          if (existingUserWithEmail.twoFactorEnabled) {
            return redirect(await loginWithTotp(existingUserWithEmail.email));
          } else {
            return allow(existingUserWithEmail.id);
          }
        }

        // check if user was invited
        if (
          !existingUserWithEmail.password?.hash &&
          !existingUserWithEmail.emailVerified &&
          !existingUserWithEmail.username
        ) {
          await prisma.user.update({
            where: {
              email: existingUserWithEmail.email,
            },
            data: {
              // update the email to the IdP email
              email: user.email,
              // Slugify the incoming name and append a few random characters to
              // prevent conflicts for users with the same name.
              username: getOrgUsernameFromEmail(user.email, getDomainFromEmail(user.email)),
              emailVerified: new Date(Date.now()),
              name: user.name,
              identityProvider: idP,
              identityProviderId: account.providerAccountId,
            },
          });

          if (existingUserWithEmail.twoFactorEnabled) {
            return redirect(await loginWithTotp(existingUserWithEmail.email));
          } else {
            return allow(existingUserWithEmail.id);
          }
        }

        // User signs up with email/password and then tries to login with Google/SAML/AzureAD using the same email
        if (
          existingUserWithEmail.identityProvider === IdentityProvider.CAL &&
          (idP === IdentityProvider.GOOGLE ||
            idP === IdentityProvider.SAML ||
            idP === IdentityProvider.AZUREAD)
        ) {
          // Prevent account pre-hijacking: block OAuth linking for unverified accounts
          if (!existingUserWithEmail.emailVerified) {
            return redirect("/auth/error?error=unverified-email");
          }

          await prisma.user.update({
            where: { email: existingUserWithEmail.email },
            data: {
              email: user.email.toLowerCase(),
              identityProvider: idP,
              identityProviderId: account.providerAccountId,
            },
          });

          if (existingUserWithEmail.twoFactorEnabled) {
            return redirect(await loginWithTotp(existingUserWithEmail.email));
          } else {
            return allow(existingUserWithEmail.id);
          }
        } else if (existingUserWithEmail.identityProvider === IdentityProvider.CAL) {
          log.error(`Userid ${user.id} already exists with CAL identity provider`);
          return redirect(
            `/auth/error?error=wrong-provider&provider=${existingUserWithEmail.identityProvider}`
          );
        } else if (
          existingUserWithEmail.identityProvider === IdentityProvider.GOOGLE &&
          idP === IdentityProvider.AZUREAD
        ) {
          await prisma.user.update({
            where: { email: existingUserWithEmail.email },
            data: {
              email: user.email.toLowerCase(),
              identityProvider: idP,
              identityProviderId: account.providerAccountId,
            },
          });

          if (existingUserWithEmail.twoFactorEnabled) {
            return redirect(await loginWithTotp(existingUserWithEmail.email));
          } else {
            return allow(existingUserWithEmail.id);
          }
        } else if (
          existingUserWithEmail.identityProvider === IdentityProvider.AZUREAD &&
          idP === IdentityProvider.GOOGLE
        ) {
          await prisma.user.update({
            where: { email: existingUserWithEmail.email },
            data: {
              email: user.email.toLowerCase(),
              identityProvider: idP,
              identityProviderId: account.providerAccountId,
            },
          });

          if (existingUserWithEmail.twoFactorEnabled) {
            return redirect(await loginWithTotp(existingUserWithEmail.email));
          } else {
            return allow(existingUserWithEmail.id);
          }
        }
        log.error(`Userid ${user.id} trying to login with the wrong provider`, {
          userId: user.id,
          account: {
            providerAccountId: account?.providerAccountId,
            type: account?.type,
            provider: account?.provider,
          },
        });
        return redirect(
          `/auth/error?error=wrong-provider&provider=${existingUserWithEmail.identityProvider}`
        );
      }

      // Associate with organization if enabled by flag and idP is Google or Azure AD
      const { orgUsername, orgId } = await checkIfUserShouldBelongToOrg(idP, user.email);

      try {
        const newUsername = orgId ? slugify(orgUsername) : usernameSlug(user.name);
        const newUser = await prisma.user.create({
          data: {
            // Slugify the incoming name and append a few random characters to
            // prevent conflicts for users with the same name.
            username: newUsername,
            emailVerified: new Date(Date.now()),
            name: user.name,
            ...(user.image && { avatarUrl: user.image }),
            email: user.email,
            identityProvider: idP,
            identityProviderId: account.providerAccountId,
            ...(orgId && {
              verified: true,
              organization: { connect: { id: orgId } },
              teams: {
                create: { role: MembershipRole.MEMBER, accepted: true, team: { connect: { id: orgId } } },
              },
            }),
            creationSource: CreationSource.WEBAPP,
          },
        });
        await this.linkAccount(account, newUser.id);

        // Update profile photo for new Microsoft/Azure AD users
        if (account.provider === "azure-ad" && account.access_token) {
          await this.updateMicrosoftPhoto(account.access_token, newUser.id);
        }

        if (newUser.twoFactorEnabled) {
          return redirect(await loginWithTotp(newUser.email));
        } else {
          return allow(newUser.id);
        }
      } catch (err) {
        log.error("Error creating a new user", err);
        return redirect(`/auth/error?error=user-creation-error`);
      }
    }

    log.warn("callbacks:signIn - no matching provider or condition, denying access", {
      provider: account?.provider,
      accountType: account?.type,
    });
    return deny;
  }

  /**
   * Finishes an `allow`: links the provider account when the user has none (the source adapter did this
   * for e-mail auto-merges) and runs the default-calendar install for a user tied to this provider id.
   */
  async completeSignIn({
    userId,
    user,
    account,
  }: {
    userId: number;
    user: OAuthUser;
    account: OAuthAccount;
  }): Promise<void> {
    const linked = await prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: account.provider,
          providerAccountId: account.providerAccountId,
        },
      },
      select: { id: true },
    });
    if (!linked) await this.linkAccount(account, userId);

    const idP = getIdentityProvider(account.provider);
    if (!idP) return;
    const tiedToProvider = await prisma.user.findFirst({
      where: { identityProvider: idP, identityProviderId: account.providerAccountId },
      select: { id: true },
    });
    if (!tiedToProvider) return;
    await this.installDefaultCalendars({ userId, email: user.email, account });
  }

  /**
   * Runs for a user already tied to this identity provider id: installs the default calendar
   * credentials the granted scopes allow and refreshes the Microsoft profile photo.
   */
  async installDefaultCalendars({
    userId,
    email,
    account,
  }: {
    userId: number;
    email: string | null | undefined;
    account: OAuthAccount;
  }) {
    const grantedScopes = account.scope?.split(" ") ?? [];
    if (
      account.provider === "google" &&
      !(await CredentialRepository.findFirstByAppIdAndUserId({
        userId,
        appId: "google-calendar",
      })) &&
      GOOGLE_CALENDAR_SCOPES.every((scope) => grantedScopes.includes(scope))
    ) {
      // Installing Google Calendar by default
      const credentialkey = {
        access_token: account.access_token,
        refresh_token: account.refresh_token,
        id_token: account.id_token,
        token_type: account.token_type,
        expires_at: account.expires_at,
      };
      const gcalCredentialData = buildCredentialCreateData({
        userId,
        key: credentialkey,
        appId: "google-calendar",
        type: "google_calendar",
      });
      const gcalCredential = await CredentialRepository.create(gcalCredentialData);
      const gCalService = createGoogleCalendarServiceWithGoogleType({
        ...gcalCredential,
        user: null,
        delegatedTo: null,
      });

      if (
        !(await CredentialRepository.findFirstByUserIdAndType({
          userId,
          type: "google_video",
        }))
      ) {
        const googleMeetCredentialData = buildCredentialCreateData({
          type: "google_video",
          key: {},
          userId,
          appId: "google-meet",
        });
        await CredentialRepository.create(googleMeetCredentialData);
      }

      const { client_id, client_secret } = GOOGLE_API_CREDENTIALS();
      const oAuth2Client = new OAuth2Client(client_id, client_secret);
      oAuth2Client.setCredentials(credentialkey);
      const calendar = new calendar_v3.Calendar({
        auth: oAuth2Client,
      });
      const primaryCal = await gCalService.getPrimaryCalendar(calendar);
      if (primaryCal?.id) {
        await gCalService.createSelectedCalendar({
          externalId: primaryCal.id,
          userId,
        });
      }
      await updateProfilePhotoGoogle(oAuth2Client, userId);
    }

    // Installing Outlook Calendar by default for Microsoft/Azure AD sign-in
    // Note: offline_access is requested but not returned in scope list by Microsoft
    const microsoftCalendarScopesToCheck = MICROSOFT_CALENDAR_SCOPES.filter(
      (scope) => scope !== "offline_access"
    );
    if (
      account.provider === "azure-ad" &&
      !(await CredentialRepository.findFirstByAppIdAndUserId({
        userId,
        appId: "office365-calendar",
      })) &&
      microsoftCalendarScopesToCheck.every((scope) => grantedScopes.includes(scope))
    ) {
      const credentialKey = {
        access_token: account.access_token,
        refresh_token: account.refresh_token,
        email,
        // convert seconds to milliseconds — OAuthManager compares expiry_date against Date.now()
        expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
      };

      const outlookCredentialData = buildCredentialCreateData({
        userId,
        key: credentialKey,
        appId: "office365-calendar",
        type: "office365_calendar",
      });
      const outlookCredential = await CredentialRepository.create(outlookCredentialData);

      // Fetch default calendar from Microsoft Graph API
      try {
        const calendarResponse = await fetch(
          "https://graph.microsoft.com/v1.0/me/calendars?$select=id,isDefaultCalendar",
          {
            headers: {
              Authorization: `Bearer ${account.access_token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (calendarResponse.ok) {
          const calendarData = await calendarResponse.json();
          const defaultCalendar = calendarData.value?.find(
            (cal: { isDefaultCalendar?: boolean }) => cal.isDefaultCalendar
          );

          if (defaultCalendar?.id) {
            await prisma.selectedCalendar.create({
              data: {
                userId,
                integration: "office365_calendar",
                externalId: defaultCalendar.id,
                credentialId: outlookCredential.id,
              },
            });
          }
        }
      } catch (error) {
        log.error("Failed to fetch default calendar for Microsoft sign-in", error);
      }

      // Update profile photo for Microsoft/Azure AD sign-in
      if (account.access_token) {
        await this.updateMicrosoftPhoto(account.access_token, userId);
      }
    } else if (account.provider === "azure-ad" && account.access_token) {
      // Update profile photo even if calendar wasn't installed
      await this.updateMicrosoftPhoto(account.access_token, userId);
    }
  }

  // The photo is cosmetic, so a failure must not undo a sign-up that already created the user.
  private async updateMicrosoftPhoto(accessToken: string, userId: number) {
    try {
      await updateProfilePhotoMicrosoft(accessToken, userId);
    } catch (error) {
      log.error("Failed to update Microsoft profile photo", error);
    }
  }
}
