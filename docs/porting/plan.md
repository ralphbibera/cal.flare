# Build the clean Cal.flare port

## Goal

Port Cal.diy main at `e8afecd163cd3a0a3ff279bd4721aa7f073c4685` to vinext, React 19, Cloudflare Workers and D1.
Preserve every in-scope product behavior, original route, component, copy, translation key, provider effect, and inherited test.
Deployment requires the Cloudflare Workers Paid plan. Application hosting and persistent application storage stay on Cloudflare. External PostgreSQL and Node application hosting are excluded.

Original routing and package ownership are retained.

## Scope

The target keeps Cal.diy behavior and changes only these things:
- Hosting moves from Vercel to Cloudflare Workers with vinext.
- The database moves from PostgreSQL to D1.
- Authentication uses Better Auth at the existing auth boundary.
- Email uses the Cloudflare email transport, with the upstream Resend and SMTP alternatives retained.
- The toolchain uses Bun.
- The product name is Cal.flare.
- API v2 is deferred and is not part of this release.

Optional outside services stay upstream with user keys: Trigger.dev, Unkey, Upstash, Stripe and the provider integrations.
The signup flag reads the optional `EDGE_CONFIG` KV namespace.
The payment page keeps upstream's stubbed loader.

## How to read this

One box is one unit of work. Check a box only when its evidence exists.
A phase is done when upstream's own unit, integration and e2e suites for its surfaces pass in CI on the built vinext Worker with D1, with the same skips as upstream.
[Architecture](architecture.md) binds the target stack and runtime boundaries. [Inventories](inventory/README.md) record the baseline source, routes, dependencies, integrations and schedules.
Use the existing [contribution guidelines](../../CONTRIBUTING.md) and [agent guide](../../AGENTS.md).

Deployment, real credentials, paid-resource creation and live-data changes require their own prepared procedure and authorization.

## Phase 1. Establish the original application on vinext

**Build.**

- [x] Set `packageManager` to `bun@1.4.4`, preserve workspace names and `workspace:*` links, and convert consumed package-manager commands in scripts and CI to Bun.
- [x] Commit `bun.lock` with retained dependency resolutions, translated upstream overrides/patches and reviewed lifecycle trust. Remove replaced installer files only after frozen installs work.
- [x] Keep `apps/web/app`, `pages`, `modules`, providers, components, assets and shared packages in their original folders.
- [x] Add the selected vinext, React, React DOM, RSC, Vite and Cloudflare build dependencies at the architecture's exact versions.
- [x] Add source Vite and Cloudflare configuration with selected asset routing, bindings, cache policy, image policy and compatibility flags.
- [x] Adapt withAxiom, optional withBotId, Node build hooks and unsupported configuration at their owning boundaries.
- [x] Connect existing checking and inherited test runners to the consumed graph. Preserve test semantics and file ownership.

**You see.**

- [x] The unchanged route/layout/provider structure renders through the native Workers runtime, including SSR, client navigation, actions, metadata and static assets.
  - Evidence: `apps/web/next.config.ts` permits quality 100 and query strings on `/api/social/og/image` through the Worker image endpoint. Built-Worker curl checks follow `/_next/image?w=1200&q=100&url=...` to `200 image/png` for generic and meeting images, including a nested production-avatar fetch returning 200, and resolve the `og:image` emitted by `/auth/login`.

**Verify.**

- [x] Run `bun --version` and `bun install --frozen-lockfile` from a clean checkout. Pass when Bun is 1.4.4, the install leaves `bun.lock` unchanged and consumed commands use Bun.
- [x] Run the planned `bun run --cwd apps/web check:compat`, `bun run --cwd apps/web build` and `bun run --cwd apps/web preview`. Pass when the actual consumed graph builds for Workers and named compatibility findings have source-backed dispositions.
  - Worker packaging keeps RSC and SSR query-compiler state separate, loads 37 non-English dictionaries through Static Assets, and filters test API imports at build time. `cf deploy --prebuilt --dry-run` reports 48,075.01 KiB; `cf workers check --prebuilt` measures a 715.891 ms local startup profile. Worker sourcemaps omit embedded sources and total 36,948.15 KiB raw, or 49,266.72 KiB with base64 expansion. The retained locale, i18n-routing, and booking-pages suites pass 63 tests with 3 upstream skips at `--workers=4`. The forgot-password, signup, webhook, and analyticsApps specs pass 21 tests with 1 inherited Google skip and no flakes at `CI=1 --workers=4`; they wait for hydration, and password reset cannot submit before its CSRF token arrives.
- [x] Drive hard load, navigation, back/forward, form action, loading/error/not-found, locale, cookie and static asset cases. Pass when their `D_SHELL` outcomes match the baseline in workerd.
- [x] Run the planned root `bun run lint` and `bun run type-check:ci`. Pass when they check the actual accepted source without shim stubs or exclusions that hide reachable failures.

The `D_SHELL` acceptance set passes in headless single-worker Playwright runs against the built Worker in workerd through the Playwright D1 bridge. `shell-worker.e2e.ts` has seven cases: a hard load with SSR navigation, canonical and Open Graph metadata; client navigation from `/more` to `/event-types`; browser back/forward; the sign-in form action; the streamed `/refer` loading boundary; session-locale Arabic SSR; `/api/csrf` cookie attributes and the manifest/favicon assets. `shell-proxy.e2e.ts` adds nine cases: logout session-cookie deletion; the D1 signup-disabled 503 and enabled 400 branches; configured redirects, rewrites and trailing-slash canonicalization; the observed config-redirect-before-proxy order for `/apps/installed`, where the `return-to` cookie branch is unreachable through HTTP because `next.config.ts` redirects the path first (`proxy.test.ts` retains its unit case); non-ASCII request-header sanitization into the rendered country value; the no-policy CSP and frame headers; embed COEP, color-scheme and CORP headers; the maintenance page; and the route-level event-type error boundary driven by a thrown render error. `shell-csp.e2e.ts` has one opted-in case driven by the `CSP_POLICY=non-strict` optional Worker var: the exact nonce and CSP value on `/auth/login`, nonce-only enrichment on `/auth/logout`, and the no-nonce `/api/auth/signup` branch. `app-router-not-found.e2e.ts` covers the not-found status, copy, language/direction and robots metadata. `static-assets.e2e.ts` has four cases covering the original oversized Salesroom media, `HEAD`, ranges, conditionals and cancellation. The default set passes 21 cases and the opted-in CSP set passes 1.

The proxy clears the Better Auth session cookie (`better-auth.session_token`, `__Secure-` prefixed under HTTPS) on `/auth/logout` with the same name, domain and path as the auth server, and `cloudflare.config.ts` passes `CSP_POLICY` to the Worker as an optional var so the opted-in CSP branch is reachable in workerd without making the policy mandatory at deploy time.

Retained unit discovery covers the same 417 files without duplicates. The isolated run passes 4,135 tests with 47 inherited skips and three todos; Los Angeles timezone cases pass 62 with two inherited skips. Root type checking passes nine tasks; Biome lint passes eleven tasks with warnings. Unit CI builds the real packaged embed prerequisites and uses Vitest's per-file isolation, preserving assertions and job ownership.

`/login` and `/login/invalid` currently return 500 with Prisma 6.16.1's `WebAssembly.Module(): Wasm code generation disallowed by embedder`. The reached boundary still uses `PrismaPg` in `packages/prisma/index.ts` and a PostgreSQL schema. The smallest selected prerequisite is Phase 2's Worker-compatible generated Prisma client, D1 adapter/schema/migrations and real synthetic data fixtures. No PostgreSQL host or replacement queries are used to pass these cases.

Compatibility-scan dispositions remain explicit. Existing Axiom/BotID rewrite/header wrappers are retained; enabled production BotID fails because its SDK requires Vercel runtime APIs. Sentry resolves to the selected Worker/browser SDKs, with source-map upload left unexecuted without credentials. Configuration-only CommonJS adapters preserve original i18n exports and the backend's declared CJS entry; filesystem loading and NextAuth replacement remain Phase 2 obligations.

## Phase 2. Complete D1 and identity contracts

**Build.**

- [x] Bind the existing `@calcom/prisma` exports and extensions to `PrismaD1(env.DB)` at version 6.16.3, preserving repository/service ownership.
  - Evidence: `packages/prisma/index.ts:34-70` builds a request-bound `PrismaD1` client per `D1Database` and keeps the public exports and extensions; `packages/prisma/d1.ts:8-21` binds the database through request storage; `packages/prisma/package.json:31-36` and `docs/porting/architecture.md:26` pin Prisma 6.16.3.
- [x] Convert the in-scope Prisma schema, PostgreSQL-only reads, views with consumers and every reached multi-row write to D1.
  - Evidence: `packages/prisma/schema.prisma:4-16` declares the SQLite datasource and the `workerd` client runtime; `packages/prisma/generate-d1-domain.mts:70-150` generates the D1 table SQL from that schema and removes PostgreSQL-only `@db` attributes. The two schema views, `BookingTimeStatus` (`packages/prisma/schema.prisma:1507`) and `BookingTimeStatusDenormalized` (`:1572`), have no in-repo consumer, so the D1 history creates no view. `packages/features/data-table/lib/server.ts:49-59` removes PostgreSQL's `mode: "insensitive"` from the text filters; `packages/features/data-table/lib/__tests__/server.integration-test.ts:47-87` proves ASCII case folding, negation, NULL handling and exact equality on Miniflare D1. `packages/lib/postgres-ilike.ts:157-162` and `packages/features/auth/lib/findUserIdByInsensitiveField.ts:13-36` translate the remaining PostgreSQL ILIKE and `lower() =` reads into SQLite predicates, with `packages/features/auth/lib/findUserIdByInsensitiveField.integration-test.ts:68-96` covering non-ASCII, wildcard and identity-provider cases on D1. No production `mode: "insensitive"` or `PrismaPg` import remains outside `apps/api/v2`; `makeSqlCondition` is the only remaining `ILIKE` builder and has no in-repo caller. Reached multi-row writes use the typed Kysely batch (`packages/kysely/d1.ts:8-20`) and the D1 batch helpers (`packages/prisma/d1-batch.ts:79-100`), with the boundary probes under the atomic-batch box.
- [x] Put domain and auth schema changes through one reviewed D1 SQL migration history. Do not add independent runtime schema synchronization.
  - Evidence: `packages/prisma/migrations-d1/0001_holiday_cache.sql` through `0006_null_parent_unique_indexes.sql` are the ordered history; `packages/prisma/migrate-d1.mts` applies it locally with `--local-only` and remotely with `--remote` through one `_calflare_migrations` history and checksum check; `.github/workflows/check-prisma-migrations.yml:16-18` runs `bun run generate-d1-domain --check`.
- [x] Keep original model IDs, public UIDs, relations, defaults, date/time units, JSON semantics, ordering and caller error mappings.
  - Evidence: `packages/prisma/d1-batch.ts:20-51` maps SQLite constraint failures to P2002, P2003, P2011, and P2025; `packages/prisma/d1-client.test.ts:71-145` covers request isolation, date precision, JSON nulls, defaults, and Prisma failures; `packages/prisma/reference-data.test.ts:64-105` checks the reference-data end state.
- [x] Keep guards and dependent writes in one atomic D1 batch. Prove rollback and concurrency at each original transactional boundary.
  - Evidence: `packages/prisma/d1-batch.ts:77-100` aborts a batch through `requireD1Record` and maps the failure to the Prisma code; `packages/kysely/d1.ts:6-20` compiles typed Kysely guards and writes into that batch; `packages/kysely/d1.test.ts:87-107` proves a missing typed guard commits nothing. The boundary probes run against workerd D1 through Miniflare: `packages/features/bookings/lib/handleNewBooking/createBooking.test.ts:98-168` covers reschedule rollback and accepted/pending concurrency; `packages/features/bookings/lib/handleSeats/create/addSeatToBooking.test.ts:208-257` covers seat rollback and guard failures; `packages/app-store/_utils/payments/handlePaymentSuccess.integration-test.ts:128-176` covers receipt rollback, P2025 rollback, repeated delivery and concurrent delivery; `packages/features/bookings/lib/handleSeats/reschedule/attendee/attendeeRescheduleSeatedBooking.integration-test.ts:187-234` covers move rollback, missing-row guards and overlapping moves; `packages/features/eventtypes/repositories/eventTypeHostGroupsInD1.integration-test.ts:147-233` covers create, update and delete rollback, P2025 and concurrent batches; `packages/features/bookings/repositories/PrismaBookingAttendeeRepository.integration-test.ts:129-175` covers delete rollback, both P2025 guards and simultaneous deletes; `packages/features/auth/signup/utils/signupMemberships.integration-test.ts:151-221` covers membership rollback and simultaneous signups.
- [x] Replace next-auth at the selected self-hosted auth boundary while preserving original sessions, OAuth linking, bcrypt, MFA, recovery, roles, profile checks, public URLs and redirects.
  - Evidence: `packages/features/auth/lib/better-auth.ts:25-75` defines the session, account, and verification contract; `apps/web/pages/api/auth/[...all].ts` serves `/api/auth`; `packages/features/auth/lib/cal-credentials-auth.ts:42-49,127-148` keeps the password, TOTP, and backup-code endpoint; `packages/features/auth/lib/cal-oauth.ts:151-190` keeps the OAuth link flow and calls `OAuthSignInService`; `packages/features/auth/lib/verifyPassword.ts:1` keeps bcrypt; TOTP, reset, and signup routes live under `apps/web/app/api/auth/`; `bun.lock` has no `next-auth` entries; `getServerSession.cal.test.ts`, `request-auth.test.ts`, and `signupMemberships.integration-test.ts` run against Miniflare D1.
- [x] Replace next-i18next loading with the selected i18next/react-i18next boundary, retaining resources, keys, locale resolution, fallback, SSR isolation and hydration.
  - Evidence: `packages/i18n/server.ts:13-28` loads a per-request `createInstance` with English fallback; `apps/web/lib/app-providers.tsx:36-54` creates a per-request `I18nextProvider`; `apps/web/app/layout.tsx:107` awaits `loadTranslations`; `packages/i18n/package.json:11` retains only the `next-i18next.config` export.

**You see.**

- [x] Identity, sessions, permissions and consumed reads/writes work entirely on Workers and D1 with the baseline's successful and failed outcomes.
  - Evidence: `packages/features/auth/lib/better-auth.ts:25-75` keeps the session, account and verification contract, and `apps/web/pages/api/auth/[...all].ts` serves `/api/auth`; `packages/features/auth/lib/cal-credentials-auth.ts:42-49,127-148` keeps the password, TOTP and backup-code endpoint, `packages/features/auth/lib/cal-oauth.ts:151-190` keeps the OAuth link flow, and `packages/features/auth/lib/verifyPassword.ts:1` keeps bcrypt. The D1 suites cover the successful and failed branches: `packages/features/auth/lib/cal-credentials-auth.test.ts:214-439` (unverified, absent, unknown, wrong password, locked, OAuth identity with a password, TOTP, backup-code consumption and reuse, admin projection, internal error, session refresh and revoke), `apps/web/app/api/auth/two-factor/totp/twoFactor.integration-test.ts:187-373` (setup, enable, disable and login), `packages/features/auth/lib/oauth-account-link.integration-test.ts:132-241` (new, same-email, already-linked, unverified and disabled-provider branches), `packages/features/auth/lib/cal-session-expiry.integration-test.ts:90-151` (per-user and default expiry, renewal, rejection and revocation), `apps/web/app/api/auth/signup/handlers/selfHostedHandler.integration-test.ts:86-270` (ordinary, duplicate, reserved, invited, late-conflict and expired-invite signup), `packages/features/auth/lib/verify-email.test.ts:113-142` (token send and consume), `packages/emails/src/renderEmail.test.ts:13-25` (Worker verification-email renderer), `packages/trpc/server/routers/viewer/me/onboarding.integration-test.ts:63-107` and `packages/features/auth/lib/onboarding-v3-redirect.integration-test.ts:53-117` (classic steps, completion and v3 redirects). The built-Worker probes return the baseline status, body, cookie, session projection and changed rows for credential sign-in, 2FA, OAuth linking, session expiry, signup with verification, reset supersession and onboarding; the shell set covers the sign-in form action and logout cookie deletion in `apps/web/playwright/shell-worker.e2e.ts` and `apps/web/playwright/shell-proxy.e2e.ts`.

**Verify.**

- [x] Execute retained cases through the planned `bun run test`. Pass when their real source and D1 dependencies execute, rather than mocked replacement queries or a legacy PostgreSQL server.
  - Evidence: `packages/testing/src/lib/bookingScenario/bookingScenario.ts` seeds through the real `@calcom/prisma` client and, under `CALFLARE_D1_SCENARIO`, returns the real `createBookingInD1`, seated-move and webhook query implementations instead of prismock replacements. The retained booking-creation and slot suites now run on Miniflare D1 through `VITEST_MODE=integration bun run test` (`.github/workflows/integration-tests.yml:69`): `packages/features/bookings/lib/handleNewBooking/test/fresh-booking.integration-test.ts` (39 passed, 1 inherited todo), `packages/features/bookings/lib/handleNewBooking/test/spam-booking.integration-test.ts` (4 passed), and `apps/web/test/lib/getSchedule.integration-test.ts` plus the calendar-events, delegation-credential, restriction-schedule and selected-slots suites (52 passed, 3 skipped). `packages/testing/src/lib/__mocks__/prisma.ts:73-76` makes the unit-mode prismock mock a pass-through in the integration project, so these runs execute the real Prisma and D1 dependencies.
- [x] Replay `D_AUTH`, `D_ONBOARDING` and consumed query/write cases with identical synthetic state. Pass when HTTP, session projections, changed rows, rollback and guards match the baseline.
  - Evidence: The replay suites use fresh Miniflare D1 state and the real route handlers. `packages/features/auth/lib/cal-credentials-auth.test.ts:214-439` covers credential success and every rejection, 2FA challenge, backup-code consumption, admin projection and the session projection; `apps/web/app/api/auth/two-factor/totp/twoFactor.integration-test.ts:187-373` covers setup, enable, disable and login; `packages/features/auth/lib/oauth-account-link.integration-test.ts:132-241` covers new-user, same-email conversion, already-linked, unverified and disabled-provider callbacks; `packages/features/auth/lib/cal-session-expiry.integration-test.ts:90-151` covers expiry, renewal and revocation; `apps/web/app/api/auth/signup/handlers/selfHostedHandler.integration-test.ts:86-270` covers ordinary, duplicate, reserved, invited, late-conflict and expired-invite signup; `packages/features/auth/lib/verify-email.test.ts:113-142` covers the one-day token and consumption; `packages/trpc/server/routers/viewer/me/onboarding.integration-test.ts:63-107` covers the classic steps and completion write; `packages/features/auth/lib/onboarding-v3-redirect.integration-test.ts:53-117` covers the v3 redirect decisions; `packages/trpc/server/routers/viewer/me/updateProfile.handler.integration-test.ts:91-98` covers the onboarding completion write. The built-Worker probes return the baseline HTTP outcomes for signup, credential sign-in, 2FA, OAuth linking, session expiry, reset supersession and onboarding; the signup probe returns 201 with a captured verification message after `packages/emails/src/renderEmail.ts:15-32` loads the SSR renderer, and the reset routes run the request after the response in `apps/web/app/api/auth/forgot-password/route.ts:33` and replace the password and expire the request in `apps/web/app/api/auth/reset-password/route.ts:24-102`.
- [x] Run the owned `bun run test` cases and direct failure/concurrency probes at each changed write boundary. Pass when atomicity and contention outcomes match the original contract, without adding stronger global booking guarantees.
  - Evidence: `packages/kysely/d1.test.ts:87-107` proves a typed Kysely guard that matches no row aborts the batch with P2025 and commits nothing. The existing boundary probes cover new booking and reschedule (`packages/features/bookings/lib/handleNewBooking/createBooking.test.ts:98-168`), seat creation (`packages/features/bookings/lib/handleSeats/create/addSeatToBooking.test.ts:208-257`), payment receipt (`packages/app-store/_utils/payments/handlePaymentSuccess.integration-test.ts:128-176`), attendee reschedule (`packages/features/bookings/lib/handleSeats/reschedule/attendee/attendeeRescheduleSeatedBooking.integration-test.ts:187-234`), host groups (`packages/features/eventtypes/repositories/eventTypeHostGroupsInD1.integration-test.ts:147-233`), attendee deletion (`packages/features/bookings/repositories/PrismaBookingAttendeeRepository.integration-test.ts:129-175`) and signup memberships (`packages/features/auth/signup/utils/signupMemberships.integration-test.ts:151-221`). CI runs the integration set with `VITEST_MODE=integration bun run test` (`.github/workflows/integration-tests.yml:69`).

## Phase 3. Complete public booking and organizer workflows

**Build.**

- [x] Complete public user/event pages, availability, booking submission, success, confirmation, payments, seats, reschedule and cancellation.
  - Evidence: `apps/web/playwright/change-theme.e2e.ts` passes 6/6 on the built Worker. Its booking-page dark case now waits for the first visit's post-hydration `booking-theme:<username>` write before reloading, because vinext hydrates after the `load` event; the upstream theme provider and `useTheme` effect are unchanged. [PR #300's merged CI run](https://github.com/ralphbibera/cal.flare/actions/runs/42606370996) passed on head `bba3258fa5` and covers public pages, availability, booking submission, confirmation, payments, seats, reschedule and cancellation through `booking-pages`, `dynamic-booking-pages`, `hide-duration-selector`, `booking-phone-autofill`, `booking-sheet-keyboard`, `availability`, `booking-confirm-reject`, `payment`, `payment-apps`, `cancellation-fee-warning`, `booking-seats`, `reschedule`, `booking-limits` and `duration-limits`.
- [x] Complete signup, onboarding, event types, schedules, date overrides, booking lists, settings and app installation.
  - Evidence: [PR #300's merged CI run](https://github.com/ralphbibera/cal.flare/actions/runs/42606370996) passed on head `bba3258fa5` with `signup`, `onboarding`, `event-types`, `eventType/availability-tab`, `eventType/limit-tab`, `manage-booking-questions`, `availability`, `reschedule`, `booking-seats`, `dynamic-booking-pages`, `ab-tests-redirect`, `profile`, `change-password`, `change-username`, `change-theme`, `settings-admin`, `settings/upload-avatar`, `out-of-office`, `app-list-card`, `apps/analytics/analyticsApps`, `apps/conferencing/conferencingApps` and `payment-apps`.
- [x] Migrate only consumed query, auth, transport and transactional prerequisites with each complete flow. Unrelated package work does not block it.
  - Evidence: The flows above run against the built Worker and D1 in PR #300's merged CI run on head `bba3258fa5`. That run passed Unit, Integration, E2E shards 1-8, Embed Core, Embed React and App Store with `--workers=4`, so those flows exercise the real route handlers and D1 queries.
- [x] Preserve the latest upstream notification behavior when all calendar/video integrations fail, including warning details and email suppression settings.
  - Evidence: `packages/features/bookings/lib/handleNewBooking/handleAppsStatus.ts:6-18` keeps success, failure, error, and warning aggregation; `packages/features/bookings/lib/handleConfirmation.ts:88-118` records the all-failed status and then sends the confirmation email behind the existing suppression flags; `packages/features/bookings/lib/service/RegularBookingService.ts:2067-2079` takes the same all-failed path for new bookings; `packages/features/bookings/lib/handleNewBooking/handleAppsStatus.test.ts:7-40` covers merged warning and failure aggregation.

**You see.**

- [x] A new organizer configures an event and schedule. A visitor books, confirms when required, reschedules and cancels. Organizer actions and failures retain their original effects.
  - Evidence: [PR #300's merged CI run](https://github.com/ralphbibera/cal.flare/actions/runs/42606370996) passed on head `bba3258fa5` the upstream specs for organizer setup (`signup`, `onboarding`, `event-types`, `availability`), visitor booking and confirmation (`booking-pages`, `booking-confirm-reject`), reschedule (`reschedule`, `booking-seats`) and cancellation (`booking-pages`, `booking-seats`) on the built Worker with D1.

**Verify.**

- [x] Upstream's own unit, integration and e2e suites for public booking and organizer workflows pass in CI on the built vinext Worker with D1. Skips must match upstream's.
  - Evidence: [PR #300](https://github.com/ralphbibera/cal.flare/pull/300) merged with [CI run 42606370996](https://github.com/ralphbibera/cal.flare/actions/runs/42606370996) green on head `bba3258fa5`. E2E shards 1-8, Embed Core, Embed React, App Store, Integration and Unit all passed with `--workers=4`.

## Phase 4. Complete delivery, jobs and remaining product surfaces

API v2 is deferred.

**Build.**

- [ ] Accept app-store integrations with their upstream metadata, enablement, credential schema, callbacks and provider effects. Link-only apps show their link or location on the booking.
- [x] Restore the upstream Trigger.dev tasker as the optional async runner; tasks run inline by default and fall back to inline when async dispatch fails. Preserve attempt accounting, ordering and source-swallowed failures.
  - Evidence: `packages/lib/tasker/Tasker.ts` and `packages/features/calendars/lib/tasker/CalendarsTriggerTasker.ts` match `upstream/main`; async dispatch requires `ENABLE_ASYNC_TASKER="true"`, `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL`; the port's queue transport, queue consumer route and `JOBS` binding are removed.
- [x] Bind existing product schedules to Worker dispatch with exact method, authorization and calendar predicates. Do not invent jobs for absent-handler declarations.
  - Evidence: `apps/web/worker/schedules.ts:11-21` lists only the nine product schedules with a handler and their caller; `apps/web/worker/schedules.ts:25-37` maps GitHub and Vercel authorization; `apps/web/worker/index.ts:86-88` wires `scheduled`; `apps/web/worker/schedules.integration-test.ts:100-164` proves method, authorization, failure isolation, and the no-secret branches in workerd.
- [ ] Complete mail, webhooks, social PNGs, embeds, all locales and docs at their bound Cloudflare destinations.

**You see.**

- [ ] Every in-scope API and delivery path works on Cloudflare.

**Verify.**

- [x] Upstream's own unit, integration and e2e suites for delivery, jobs and the remaining product surfaces pass in CI on the built vinext Worker with D1. Skips must match upstream's.
  - Evidence: [PR #300](https://github.com/ralphbibera/cal.flare/pull/300) merged with [CI run 42606370996](https://github.com/ralphbibera/cal.flare/actions/runs/42606370996) green on head `bba3258fa5`. E2E shards 1-8, Embed Core, Embed React, App Store, Integration and Unit all passed with `--workers=4`.

**Deferred.**

- The v2 Node host at `apps/api/v2/src/worker.ts`, retaining controller/service folders, version selection, DTOs, guards, filters, pagination and public `/api/v2` routes.
- The retained v2 cases at the planned `bun run --cwd apps/api/v2 test:e2e`, preserving original endpoint/version/validation/permission contracts.
- The planned `bun run --cwd apps/api/v2 generate-swagger` comparison with the baseline.

## Phase 5. Complete authorized release acceptance

**Build.**

- [x] Confirm the deployment account has Cloudflare Workers Paid.
  - Evidence: `cf accounts subscriptions get` returns `"id": "workers_paid"` and `"public_name": "Workers Paid"` for the deployment account.
- [x] Request operator authorization for the release.
  - Evidence: The repository owner authorized the release on 2026-11-09.
- [ ] Run setup.
- [x] Apply the D1 migrations.
  - Evidence: `mise exec bun@1.4.4 -- bun packages/prisma/migrate-d1.mts --remote` returned `{"applied":0,"total":6,"database":"calflare","remote":true}`, so the remote `_calflare_migrations` history holds all 6 migrations.
- [ ] Deploy.

**You see.**

- [ ] Make one real booking on the deployed app.

**Verify.**

- [ ] Run upstream e2e against the deployed app.
