import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import prisma from "@calcom/prisma";
import { createAuthEndpoint } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { z } from "zod";
import { calClaimsSchema, profileContextSchema } from "./cal-session";
import { getCalSessionSettings } from "./cal-session-policy";
import type { createCalSessionStore } from "./cal-session-store";
import { checkIfUserBelongsToActiveTeam } from "./checkIfUserBelongsToActiveTeam";

// Executable value of the source provider's `maxAge: 10 * 60 * 60`: 10 hours, despite its "10 min" comment.
export const MAGIC_LINK_EXPIRES_IN = 10 * 60 * 60;

// Better Auth stores magic-link tokens under this identifier prefix in AuthVerification.
const MAGIC_LINK_IDENTIFIER_PREFIX = "magic-link:";
const VERIFY_PATH = "/cal/magic-link/verify";
// Source: next-auth redirected every failed email callback to the error page with this code.
const VERIFICATION_ERROR = "Verification";

type SendMagicLinkEmail = (params: { identifier: string; url: string }) => Promise<unknown>;

type CalMagicLinkConfig = {
  webappURL: string;
  sessions: ReturnType<typeof createCalSessionStore>;
  callback: (requested?: string) => string;
  sendMagicLinkEmail?: SendMagicLinkEmail;
};

const verifyQuery = z.object({ token: z.string(), callbackURL: z.string().optional() });

// next-auth normalised the identifier before the adapter lookup.
function normalizeEmail(email: string) {
  const [local, domain = ""] = email.toLowerCase().trim().split("@");
  return `${local}@${domain.split(",")[0]}`;
}

async function sendThroughCalTemplate(params: { identifier: string; url: string }) {
  return (await import("./sendVerificationRequest")).default(params);
}

async function findOrCreateUser(email: string) {
  const user = await new UserRepository(prisma).findByEmailAndIncludeProfilesAndPassword({ email });
  if (user) return user;
  // The source email provider created the user when the address was unknown (adapter.createUser).
  await prisma.user.create({ data: { email, emailVerified: new Date() }, select: { id: true } });
  return new UserRepository(prisma).findByEmailAndIncludeProfilesAndPassword({ email });
}

export function createCalMagicLink({
  webappURL,
  sessions,
  callback,
  sendMagicLinkEmail,
}: CalMagicLinkConfig) {
  const send = sendMagicLinkEmail ?? sendThroughCalTemplate;
  const webappOrigin = new URL(webappURL).origin;

  return [
    magicLink({
      expiresIn: MAGIC_LINK_EXPIRES_IN,
      disableSignUp: true,
      sendMagicLink: async ({ email, token, url }) => {
        // The native verify endpoint cannot issue a Cal session, so the link targets Cal's own verify endpoint.
        const link = new URL(`/api/auth${VERIFY_PATH}`, webappOrigin);
        link.searchParams.set("token", token);
        const callbackURL = new URL(url).searchParams.get("callbackURL");
        if (callbackURL) link.searchParams.set("callbackURL", callbackURL);
        await send({ identifier: email, url: link.toString() });
      },
    }),
    {
      id: "cal-magic-link",
      endpoints: {
        calMagicLinkVerify: createAuthEndpoint(
          VERIFY_PATH,
          { method: "GET", query: verifyQuery, requireHeaders: true },
          async (ctx) => {
            const failure = () => {
              const target = new URL("/auth/error", webappOrigin);
              target.searchParams.set("error", VERIFICATION_ERROR);
              return ctx.redirect(target.toString());
            };
            const identifier = `${MAGIC_LINK_IDENTIFIER_PREFIX}${ctx.query.token}`;
            const { internalAdapter } = ctx.context;
            const pending = await internalAdapter.findVerificationValue(identifier);
            if (!pending) throw failure();
            const consumed = await internalAdapter.consumeVerificationValue(identifier);
            if (!consumed || consumed.expiresAt.getTime() <= Date.now()) throw failure();
            const record = z
              .object({ type: z.literal("magic-link"), email: z.string() })
              .safeParse(JSON.parse(consumed.value));
            if (!record.success) throw failure();

            const user = await findOrCreateUser(normalizeEmail(record.data.email));
            if (!user) throw failure();
            const settings = await getCalSessionSettings(user.id);
            if (!settings.emailVerified) {
              await prisma.user.update({
                where: { id: user.id },
                data: { emailVerified: new Date() },
                select: { id: true },
              });
            }
            const profile = user.allProfiles[0];
            await sessions.issue(ctx, {
              claims: calClaimsSchema.parse({
                id: user.id,
                name: user.name,
                username: user.username,
                orgAwareUsername: user.username,
                email: user.email,
                role: user.role,
                belongsToActiveTeam: checkIfUserBelongsToActiveTeam(user),
                locale: user.locale,
              }),
              profile: profileContextSchema.parse({
                profileId: profile?.id ?? null,
                upId: profile?.upId ?? null,
              }),
              sessionTimeout: settings.sessionTimeout,
              emailVerified: true,
            });
            ctx.setHeader("cache-control", "private, no-cache, no-store");
            throw ctx.redirect(callback(ctx.query.callbackURL));
          }
        ),
      },
    },
  ];
}
