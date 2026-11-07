import process from "node:process";
import { getIdentityProvider } from "@calcom/features/auth/lib/identityProviders";
import {
  OUTLOOK_CLIENT_ID,
  OUTLOOK_CLIENT_SECRET,
  OUTLOOK_LOGIN_ENABLED,
} from "@calcom/features/auth/lib/outlook";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import {
  ENABLE_PROFILE_SWITCHER,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_SCOPES,
  HOSTED_CAL_FEATURES,
  IS_CALCOM,
  MICROSOFT_CALENDAR_SCOPES,
  WEBAPP_URL,
} from "@calcom/lib/constants";
import { defaultCookies } from "@calcom/lib/default-cookies";
import { isENVDev } from "@calcom/lib/env";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { TrackingData } from "@calcom/lib/tracking";
import prisma from "@calcom/prisma";
import type { MembershipRole, UserPermissionRole } from "@calcom/prisma/enums";
import { userMetadata } from "@calcom/prisma/zod-utils";
import type { UserProfile } from "@calcom/types/UserProfile";
import { waitUntil } from "@vercel/functions";
import type { AuthOptions, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { encode } from "next-auth/jwt";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import type { Provider } from "next-auth/providers/index";
import { authorizeCredentials } from "./authorizeCredentials";
import { checkIfUserBelongsToActiveTeam } from "./checkIfUserBelongsToActiveTeam";
import { dub } from "./dub";
import CalComAdapter from "./next-auth-custom-adapter";
import { oauthProfileSchema } from "./OAuthSignIn.types";
import { OAuthSignInService } from "./OAuthSignInService";

export { authorizeCredentials } from "./authorizeCredentials";
export { checkIfUserBelongsToActiveTeam } from "./checkIfUserBelongsToActiveTeam";

const log = logger.getSubLogger({ prefix: ["next-auth-options"] });
const GOOGLE_API_CREDENTIALS = process.env.GOOGLE_API_CREDENTIALS || "{}";
const { client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET } =
  JSON.parse(GOOGLE_API_CREDENTIALS)?.web || {};
const GOOGLE_LOGIN_ENABLED = process.env.GOOGLE_LOGIN_ENABLED === "true";
const IS_GOOGLE_LOGIN_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_LOGIN_ENABLED);
export const CalComCredentialsProvider = CredentialsProvider({
  id: "credentials",
  name: "Cal.flare",
  type: "credentials",
  credentials: {
    email: { label: "Email Address", type: "email", placeholder: "john.doe@example.com" },
    password: { label: "Password", type: "password", placeholder: "Your super secure password" },
    totpCode: { label: "Two-factor Code", type: "input", placeholder: "Code from authenticator app" },
    backupCode: { label: "Backup Code", type: "input", placeholder: "Two-factor backup code" },
  },
  authorize: authorizeCredentials,
});

const providers: Provider[] = [CalComCredentialsProvider];
type SamlIdpUser = {
  id: number;
  userId: number;
  firstName: string;
  lastName: string;
  email: string;
  name: string;
  email_verified: boolean;
  profile: UserProfile;
  samlTenant?: string;
};

if (IS_GOOGLE_LOGIN_ENABLED) {
  providers.push(
    GoogleProvider({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
      authorization: {
        params: {
          scope: [...GOOGLE_OAUTH_SCOPES, ...GOOGLE_CALENDAR_SCOPES].join(" "),
          access_type: "offline",
          prompt: "consent",
        },
      },
    })
  );
}

if (OUTLOOK_LOGIN_ENABLED && OUTLOOK_CLIENT_ID && OUTLOOK_CLIENT_SECRET) {
  providers.push(
    AzureADProvider({
      clientId: OUTLOOK_CLIENT_ID,
      clientSecret: OUTLOOK_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
      authorization: {
        params: {
          scope: ["openid", "profile", "email", ...MICROSOFT_CALENDAR_SCOPES].join(" "),
          prompt: "consent",
        },
      },
      // Azure AD returns base64-encoded picture data (~9KB) that bloats the JWT cookie.
      // we exclude it here and fetch the profile photo separately via Microsoft Graph API.
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: null,
        };
      },
    })
  );
}

providers.push(
  EmailProvider({
    type: "email",
    maxAge: 10 * 60 * 60, // Magic links are valid for 10 min only
    // Here we setup the sendVerificationRequest that calls the email template with the identifier (email) and token to verify.
    sendVerificationRequest: async (props) => (await import("./sendVerificationRequest")).default(props),
  })
);

function isNumber(n: string) {
  return !Number.isNaN(parseFloat(n)) && !Number.isNaN(+n);
}

const calcomAdapter = CalComAdapter(prisma);
const oauthSignIn = new OAuthSignInService();

export const getOptions = ({
  getDubId,
  getTrackingData,
}: {
  /** so we can extract the Dub cookie in both pages and app routers */
  getDubId: () => string | undefined;
  /** Ad tracking data for Stripe customer metadata */
  getTrackingData: () => TrackingData;
}): AuthOptions => ({
  adapter: calcomAdapter,
  session: {
    strategy: "jwt",
  },
  jwt: {
    // decorate the native JWT encode function
    // Impl. detail: We don't pass through as this function is called with encode/decode functions.
    encode: async ({ token, maxAge, secret }) => {
      log.debug("jwt:encode", safeStringify({ token, maxAge }));
      if (token?.sub && isNumber(token.sub)) {
        const user = await prisma.user.findFirst({
          where: { id: Number(token.sub) },
          select: { metadata: true },
        });
        // if no user is found, we still don't want to crash here.
        if (user) {
          const metadata = userMetadata.parse(user.metadata);
          if (metadata?.sessionTimeout) {
            maxAge = metadata.sessionTimeout * 60;
          }
        }
      }
      return encode({ secret, token, maxAge });
    },
  },
  cookies: defaultCookies(WEBAPP_URL?.startsWith("https://")),
  pages: {
    signIn: "/auth/login",
    signOut: "/auth/logout",
    error: "/auth/error", // Error code passed in query string as ?error=
    verifyRequest: "/auth/verify",
    // newUser: "/auth/new", // New users will be directed here on first sign in (leave the property out if not of interest)
  },
  providers,
  callbacks: {
    async jwt({
      // Always available but with a little difference in value
      token,
      // Available only in case of signIn, signUp or useSession().update call.
      trigger,
      // Available when useSession().update is called. The value will be the POST data
      session,
      // Available only in the first call once the user signs in. Not available in subsequent calls
      user,
      // Available only in the first call once the user signs in. Not available in subsequent calls
      account,
    }) {
      log.debug("callbacks:jwt", safeStringify({ token, user, account, trigger, session }));
      // The data available in 'session' depends on what data was supplied in update method call of session
      if (trigger === "update") {
        return {
          ...token,
          profileId: session?.profileId ?? token.profileId ?? null,
          upId: session?.upId ?? token.upId ?? null,
          locale: session?.locale ?? token.locale ?? "en",
          name: session?.name ?? token.name,
          username: session?.username ?? token.username,
          email: session?.email ?? token.email,
        } as JWT;
      }
      const autoMergeIdentities = async () => {
        const existingUser = await prisma.user.findFirst({
          where: { email: token.email! },
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            name: true,
            email: true,
            role: true,
            locale: true,
            movedToProfileId: true,
            teams: {
              include: {
                team: {
                  select: {
                    id: true,
                    metadata: true,
                  },
                },
              },
            },
          },
        });

        if (!existingUser) {
          return token;
        }

        // Check if the existingUser has any active teams
        const belongsToActiveTeam = checkIfUserBelongsToActiveTeam(existingUser);
        const { teams: _teams, ...existingUserWithoutTeamsField } = existingUser;
        const allProfiles = await ProfileRepository.findAllProfilesForUserIncludingMovedUser(existingUser);
        log.debug(
          "callbacks:jwt:autoMergeIdentities",
          safeStringify({
            allProfiles,
          })
        );
        const { upId } = determineProfile({ profiles: allProfiles, token });

        const profile = await ProfileRepository.findByUpIdWithAuth(upId, existingUser.id);
        if (!profile) {
          throw new Error("Profile not found");
        }

        const profileOrg = profile?.organization;
        let orgRole: MembershipRole | undefined;
        // Get users role of org
        if (profileOrg) {
          const membership = await prisma.membership.findUnique({
            where: {
              userId_teamId: {
                teamId: profileOrg.id,
                userId: existingUser.id,
              },
            },
          });
          orgRole = membership?.role;
        }

        return {
          ...existingUserWithoutTeamsField,
          ...token,
          profileId: profile.id,
          upId,
          belongsToActiveTeam,
          orgAwareUsername: profileOrg ? profile.username : existingUser.username,
          // All organizations in the token would be too big to store. It breaks the sessions request.
          // So, we just set the currently switched organization only here.
          // platform org user don't need profiles nor domains
          org:
            profileOrg && !profileOrg.isPlatform
              ? {
                  id: profileOrg.id,
                  name: profileOrg.name,
                  slug: profileOrg.slug ?? "",
                  logoUrl: profileOrg.logoUrl,
                  fullDomain: WEBAPP_URL,
                  domainSuffix: "",
                  role: orgRole as MembershipRole, // It can't be undefined if we have a profileOrg
                }
              : null,
        } as JWT;
      };
      if (!user) {
        return await autoMergeIdentities();
      }
      if (!account) {
        return token;
      }
      if (account.type === "credentials") {
        log.debug("callbacks:jwt:accountType:credentials", safeStringify({ account }));
        // return token if credentials,saml-idp
        if (account.provider === "saml-idp") {
          const samlIdpUser = user as SamlIdpUser;
          const updatedToken = {
            ...token,
            // Server Session explicitly requires sub to be userId. So, override what is set by BoxyHQ
            sub: samlIdpUser.userId.toString(),
            upId: samlIdpUser.profile?.upId ?? token.upId ?? null,
          } as JWT;
          return updatedToken;
        }
        // any other credentials, add user info
        return {
          ...token,
          id: user.id,
          name: user.name,
          username: user.username,
          orgAwareUsername: user?.org ? user.profile?.username : user.username,
          email: user.email,
          role: user.role,
          impersonatedBy: user.impersonatedBy,
          belongsToActiveTeam: user?.belongsToActiveTeam,
          org: user?.org,
          locale: user?.locale,
          profileId: user.profile?.id ?? token.profileId ?? null,
          upId: user.profile?.upId ?? token.upId ?? null,
          inactiveAdminReason: user.inactiveAdminReason,
        } as JWT;
      }

      // The arguments above are from the provider so we need to look up the
      // user based on those values in order to construct a JWT.
      if (account.type === "oauth") {
        log.debug("callbacks:jwt:accountType:oauth", safeStringify({ account }));
        if (!account.provider || !account.providerAccountId) {
          return { ...token, upId: user.profile?.upId ?? token.upId ?? null } as JWT;
        }
        const idP = getIdentityProvider(account.provider);

        if (!idP) {
          log.warn("callbacks:jwt:accountType:oauth - unknown provider, falling back to auto-merge", {
            provider: account.provider,
          });
          return await autoMergeIdentities();
        }

        const existingUser = await prisma.user.findFirst({
          where: {
            AND: [
              {
                identityProvider: idP,
              },
              {
                identityProviderId: account.providerAccountId,
              },
            ],
          },
        });

        if (!existingUser) {
          return await autoMergeIdentities();
        }

        await oauthSignIn.installDefaultCalendars({
          userId: Number(user.id),
          email: user.email,
          account,
        });

        const allProfiles = await ProfileRepository.findAllProfilesForUserIncludingMovedUser(existingUser);
        const { upId } = determineProfile({ profiles: allProfiles, token });
        log.debug(
          "callbacks:jwt:accountType:oauth:existingUser",
          safeStringify({ userId: existingUser.id, upId })
        );
        return {
          ...token,
          upId,
          id: existingUser.id,
          name: existingUser.name,
          username: existingUser.username,
          email: existingUser.email,
          avatarUrl: existingUser.avatarUrl,
          role: existingUser.role,
          belongsToActiveTeam: token?.belongsToActiveTeam as boolean,
          impersonatedBy: token.impersonatedBy,
          org: token?.org,
          orgAwareUsername: token.orgAwareUsername,
          locale: existingUser.locale,
        } as JWT;
      }

      if (account.type === "email") {
        return await autoMergeIdentities();
      }

      log.warn(
        "callbacks:jwt - unknown account type",
        safeStringify({ accountType: account.type, accountProvider: account.provider })
      );
      return token;
    },
    async session({ session, token, user }) {
      log.debug("callbacks:session - Session callback called", safeStringify({ session, token, user }));
      const hasValidLicense = false;
      const profileId = token.profileId;
      const calendsoSession: Session = {
        ...session,
        profileId,
        upId: token.upId || session.upId,
        hasValidLicense,
        user: {
          ...session.user,
          id: token.id as number,
          name: token.name,
          username: token.username as string,
          orgAwareUsername: token.orgAwareUsername,
          role: token.role as UserPermissionRole,
          impersonatedBy: token.impersonatedBy,
          belongsToActiveTeam: token?.belongsToActiveTeam as boolean,
          org: token?.org,
          locale: token.locale,
          inactiveAdminReason: token.inactiveAdminReason,
        },
      };
      return calendsoSession;
    },
    async signIn(params): Promise<boolean | string> {
      const {
        /**
         * Available when Credentials provider is used - Has the value returned by authorize callback
         */
        user,
        /**
         * Available when Credentials provider is used - Has the value submitted as the body of the HTTP POST submission
         */
        profile,
        account,
      } = params;

      log.debug("callbacks:signin", safeStringify(params));

      if (account?.provider === "email") {
        return true;
      }
      // In this case we've already verified the credentials in the authorize
      // callback so we can sign the user in.
      // Only if provider is not saml-idp
      if (account?.provider !== "saml-idp") {
        if (account?.type === "credentials") {
          return true;
        }

        if (account?.type !== "oauth") {
          log.warn("callbacks:signIn - unsupported account type for non-saml-idp provider", {
            accountType: account?.type,
            provider: account?.provider,
          });
          return false;
        }
      }
      const decision = await oauthSignIn.signIn({
        user,
        account,
        profile: oauthProfileSchema.parse(profile ?? {}),
      });
      if (decision.kind === "redirect") return decision.to;
      return decision.kind === "allow";
    },
    /**
     * Used to handle the navigation right after successful login or logout
     */
    async redirect({ url, baseUrl }) {
      // Allows relative callback URLs
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      // Allows callback URLs on the same domain
      else if (new URL(url).hostname === new URL(WEBAPP_URL).hostname) return url;
      return baseUrl;
    },
  },
  events: {
    async signIn(message) {
      /* only run this code if:
         - it's a hosted cal account
         - DUB_API_KEY is configured
         - it's a new user
      */
      const user = message.user as User & {
        username: string;
        createdDate: string;
      };
      // check if the user was created in the last 10 minutes
      // this is a workaround – in the future once we move to use the Account model in the DB
      // we should use NextAuth's isNewUser flag instead: https://next-auth.js.org/configuration/events#signin
      const isNewUser = new Date(user.createdDate) > new Date(Date.now() - 10 * 60 * 1000);
      if ((isENVDev || IS_CALCOM) && isNewUser) {
        if (process.env.DUB_API_KEY) {
          const clickId = getDubId();
          // check if there's a clickId (dub_id) cookie set by @dub/analytics
          if (clickId) {
            // here we use waitUntil – meaning this code will run async to not block the main thread
            waitUntil(
              // if so, send a lead event to Dub
              // @see https://d.to/conversions/next-auth
              dub.track.lead({
                clickId,
                eventName: "Sign Up",
                externalId: user.id.toString(),
                customerName: user.name,
                customerEmail: user.email,
                customerAvatar: user.image,
              })
            );
          }
        }
      }
    },
  },
});

/**
 * Identifies the profile the user should be logged into.
 */
const determineProfile = ({
  token,
  profiles,
}: {
  token: JWT;
  profiles: { id: number | null; upId: string }[];
}) => {
  // If profile switcher is disabled, we can only show the first profile.
  if (!ENABLE_PROFILE_SWITCHER) {
    return profiles[0];
  }

  if (token.upId) {
    // Otherwise use what's in the token
    return { profileId: token.profileId, upId: token.upId as string };
  }

  // If there is just one profile it has to be the one we want to log into.
  return profiles[0];
};
