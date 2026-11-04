# Native D1 auth foundation

`lib/better-auth.ts` composes Better Auth 1.7.15 from an explicit request-owned DB,
public URL, existing `NEXTAUTH_SECRET`, and optional `NEXTAUTH_COOKIE_DOMAIN`.
It has no global instance or migration calls. It is not mounted in the application.
NextAuth still owns application authentication.

The four auth tables share the domain D1 database. Opaque SDK IDs remain internal.
`AuthUser.calUserId` is a required unique integer foreign key to `users.id`, with
cascade deletion. Cal user and account services remain the domain authority.
`AuthSession` retains JSON claim snapshots and optional profile context.

The migration starts from the exact native SDK schema captured in
`lib/__tests__/fixtures/better-auth.generated.sql`. The workerd test regenerates
that output through `getMigrations(...).compileMigrations()` against an empty
isolated D1 binding, then compares `0004_auth.sql` with the reviewed FK addition.
The SDK numeric field deliberately has no `references` metadata: that metadata
incorrectly infers a TEXT field from the SDK's opaque user IDs. No SDK serial-ID
mode or domain-ID string conversion is used. SDK date columns retain its `date`
declarations and native ISO-text serialization, separately from domain dates.

Session cookie attributes follow the original HTTPS/dev policy, including its
name, optional domain, HttpOnly, path, SameSite, and 30-day browser lifetime.
Cookie caching and automatic session refresh are disabled. A shorter stored
`expiresAt` is rejected even while the browser cookie remains live. Cal's
metadata-based effective timeout and explicit renewal remain pending. Their
separate 30-day browser expiry must not be replaced with the effective timeout.

Stock password sign-in, signup, social sign-in, linking, and user/password writes
are disabled. No social or MFA plugins are registered. Origin and CSRF checks
remain enabled. Do not mount this core as application login before Cal's
credential guards, MFA, permissions, account writes, session projections and
OAuth linking are integrated. Browser/server license and claim differences stay
separate. Existing JWT cookies are not Better Auth sessions.

Run library-only evidence with the inherited Vitest setup:

```sh
TMPDIR=/tmp bun run test --run --project=@calcom/lib packages/features/auth/lib/better-auth.test.ts
```

The fixture bundles the actual SDK for workerd, applies the complete committed
D1 history through the local runner, creates synthetic domain users, and issues
real signed SDK cookies through a test-only endpoint. It proves storage and
cookie contracts, not Cal login or authenticated application acceptance. It has
no live-provider, remote database, deployment, or startup-migration behavior.

Dependency graph verification keeps domain Zod 3.25.76, JOSE 4.15.9,
Prisma/client/adapter 6.16.1, and Kysely 0.28.14. Better Auth/core resolve their
own Zod 4.6.6, JOSE 6.2.15, and Kysely 0.29.8. Bun's hoisted optional peer for
`@better-auth/kysely-adapter` currently resolves Kysely 0.28.14, below its declared
range. The native tests exercise that actual graph; this is not a declaration
that every SDK operation supports that peer. Scoped resolutions did not change
optional-peer placement and were discarded. No global version override is used.
