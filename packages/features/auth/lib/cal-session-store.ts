import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { D1Environment } from "@calcom/prisma/d1";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { CalClaims, CalProfileContext } from "./cal-session";
import { calClaimsSchema, profileContextSchema, sessionExpiresAt } from "./cal-session";

type SessionContext = Parameters<typeof setSessionCookie>[0];
const authIdentitySchema = z.object({ calUserId: z.number().int().positive() });

export function createCalSessionStore({ DB }: D1Environment) {
  async function read(ctx: SessionContext) {
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
    if (!token) return null;
    const stored = await ctx.context.internalAdapter.findSession(token);
    if (!stored || stored.session.expiresAt.getTime() <= Date.now()) return null;
    const identity = authIdentitySchema.parse(stored.user);
    const claims = calClaimsSchema.parse(stored.session.calClaims);
    const profile = profileContextSchema.parse(stored.session.profileContext);
    if (identity.calUserId !== claims.id) return null;
    return { ...stored, claims, profile };
  }

  return {
    read,
    async issue(
      ctx: SessionContext,
      input: {
        claims: CalClaims;
        profile: CalProfileContext;
        emailVerified: boolean;
        sessionTimeout?: number;
      }
    ) {
      const { claims, profile } = input;
      const now = new Date().toISOString();
      // The domain row must still exist and match the authorized identity at mapping time.
      const mapping = await DB.prepare(`
        INSERT INTO "AuthUser" (id,name,email,emailVerified,createdAt,updatedAt,calUserId)
        SELECT ?,?,?,?, ?,?,id FROM users WHERE id=? AND email=? AND locked=0
        ON CONFLICT(calUserId) DO UPDATE SET
          name=excluded.name,email=excluded.email,emailVerified=excluded.emailVerified,updatedAt=excluded.updatedAt
        RETURNING id
      `)
        .bind(
          crypto.randomUUID(),
          claims.name ?? "",
          claims.email,
          Number(input.emailVerified),
          now,
          now,
          claims.id,
          claims.email
        )
        .first<{ id: string }>();
      if (!mapping)
        throw new ErrorWithCode(ErrorCode.Unauthorized, "Authorized Cal identity no longer exists");
      const user = await ctx.context.internalAdapter.findUserById(mapping.id);
      if (!user) throw new ErrorWithCode(ErrorCode.InternalServerError, "Cal auth mapping is missing");
      const session = await ctx.context.internalAdapter.createSession(
        user.id,
        false,
        {
          calClaims: claims,
          profileContext: profile,
          expiresAt: sessionExpiresAt(input.sessionTimeout),
        },
        true
      );
      if (!session) throw new ErrorWithCode(ErrorCode.InternalServerError, "Unable to create Cal session");
      await setSessionCookie(ctx, { session, user });
    },
    async renew(
      ctx: SessionContext,
      input: {
        claims: CalClaims;
        profile: CalProfileContext;
        sessionTimeout?: number;
      }
    ) {
      const current = await read(ctx);
      if (!current || current.claims.id !== input.claims.id) return null;
      const now = new Date();
      // Renewal cannot resurrect a concurrently revoked or expired session.
      const updated = await DB.prepare(`
        UPDATE "AuthSession" SET calClaims=?,profileContext=?,expiresAt=?,updatedAt=?
        WHERE token=? AND userId=? AND expiresAt>?
        RETURNING id
      `)
        .bind(
          JSON.stringify(input.claims),
          JSON.stringify(input.profile),
          sessionExpiresAt(input.sessionTimeout, now.getTime()).toISOString(),
          now.toISOString(),
          current.session.token,
          current.user.id,
          now.toISOString()
        )
        .first<{ id: string }>();
      if (!updated) return null;
      const renewed = await read(ctx);
      if (!renewed) return null;
      await setSessionCookie(ctx, renewed);
      return renewed;
    },
    async revoke(ctx: SessionContext) {
      const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
      if (token) await ctx.context.internalAdapter.deleteSession(token);
      deleteSessionCookie(ctx);
    },
  };
}
