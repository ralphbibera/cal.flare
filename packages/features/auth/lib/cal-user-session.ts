import type { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { calClaimsSchema, profileContextSchema } from "./cal-session";
import { getCalSessionSettings } from "./cal-session-policy";
import type { createCalSessionStore } from "./cal-session-store";
import { checkIfUserBelongsToActiveTeam } from "./checkIfUserBelongsToActiveTeam";

type SessionStore = ReturnType<typeof createCalSessionStore>;
type CalUser = NonNullable<
  Awaited<ReturnType<InstanceType<typeof UserRepository>["findByEmailAndIncludeProfilesAndPassword"]>>
>;

// Org and active-team claims are filled by the first session refresh, as for every Cal session issued natively.
export async function issueUserSession({
  ctx,
  sessions,
  user,
  emailVerified,
}: {
  ctx: Parameters<SessionStore["issue"]>[0];
  sessions: SessionStore;
  user: CalUser;
  emailVerified?: boolean;
}) {
  const settings = await getCalSessionSettings(user.id);
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
    emailVerified: emailVerified ?? settings.emailVerified,
  });
}
