# Build the clean Cal.flare port

## Goal

Port Cal.diy main at `e8afecd163cd3a0a3ff279bd4721aa7f073c4685` to vinext, React 19, Cloudflare Workers and D1.
Preserve every in-scope product behavior, original route, component, copy, translation key, provider effect, and inherited test.
Deployment requires the Cloudflare Workers Paid plan. Application hosting and persistent application storage stay on Cloudflare. External PostgreSQL and Node application hosting are excluded.

Original routing and package ownership are retained.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. Check a box only when its evidence exists.
A PR is verified only when its required checks and scoped acceptance pass.
[Architecture](architecture.md) binds the target stack and runtime boundaries. [Behavior](behavior.md) binds observable contracts.
[Inventories](inventory/README.md) account for original source, routes, dependencies, integrations, schedules and configuration.
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

- [ ] The unchanged route/layout/provider structure renders through the native Workers runtime, including SSR, client navigation, actions, metadata and static assets.

**Verify.**

- [x] Run `bun --version` and `bun install --frozen-lockfile` from a clean checkout. Pass when Bun is 1.4.4, the install leaves `bun.lock` unchanged and consumed commands use Bun.
- [x] Run the planned `bun run --cwd apps/web check:compat`, `bun run --cwd apps/web build` and `bun run --cwd apps/web preview`. Pass when the actual consumed graph builds for Workers and named compatibility findings have source-backed dispositions.
- [ ] Drive hard load, navigation, back/forward, form action, loading/error/not-found, locale, cookie and static asset cases. Pass when their `D_SHELL` outcomes match the baseline in workerd.
- [x] Run the planned root `bun run lint` and `bun run type-check:ci`. Pass when they check the actual accepted source without shim stubs or exclusions that hide reachable failures.

Observed Worker cases pass for the original authentication error page in English, German and Arabic, including SSR, hydration, metadata, provider placement, RTL and a navigation/back probe. Seven retained-framework Playwright cases cover that page and the original oversized Salesroom asset, including full-file SHA, middleware headers, `HEAD`, ranges, conditionals and cancellation. These cases do not accept the remaining shell flows.

Retained unit discovery covers the same 417 files without duplicates. The isolated run passes 4,135 tests with 47 inherited skips and three todos; Los Angeles timezone cases pass 62 with two inherited skips. Root type checking passes nine tasks; Biome lint passes eleven tasks with warnings. Unit CI builds the real packaged embed prerequisites and uses Vitest's per-file isolation, preserving assertions and job ownership.

`/login` and `/login/invalid` currently return 500 with Prisma 6.16.1's `WebAssembly.Module(): Wasm code generation disallowed by embedder`. The reached boundary still uses `PrismaPg` in `packages/prisma/index.ts` and a PostgreSQL schema. The smallest selected prerequisite is Phase 2's Worker-compatible generated Prisma client, D1 adapter/schema/migrations and real synthetic data fixtures. No PostgreSQL host or replacement queries are used to pass these cases.

Compatibility-scan dispositions remain explicit. Existing Axiom/BotID rewrite/header wrappers are retained; enabled production BotID fails because its SDK requires Vercel runtime APIs. Sentry resolves to the selected Worker/browser SDKs, with source-map upload left unexecuted without credentials. Configuration-only CommonJS adapters preserve original i18n exports and the backend's declared CJS entry; filesystem loading and NextAuth replacement remain Phase 2 obligations.

## Phase 2. Complete D1 and identity contracts

**Build.**

- [ ] Bind the existing `@calcom/prisma` exports and extensions to `PrismaD1(env.DB)` at version 6.16.1, preserving repository/service ownership.
- [ ] Convert the in-scope Prisma schema, PostgreSQL-only reads, views with consumers and every reached multi-row write to D1.
- [ ] Put domain and auth schema changes through one reviewed D1 SQL migration history. Do not add independent runtime schema synchronization.
- [ ] Keep original model IDs, public UIDs, relations, defaults, date/time units, JSON semantics, ordering and caller error mappings.
- [ ] Keep guards and dependent writes in one atomic D1 batch. Prove rollback and concurrency at each original transactional boundary.
- [ ] Replace next-auth at the selected self-hosted auth boundary while preserving original sessions, OAuth linking, bcrypt, MFA, recovery, roles, profile checks, public URLs and redirects.
- [ ] Replace next-i18next loading with the selected i18next/react-i18next boundary, retaining resources, keys, locale resolution, fallback, SSR isolation and hydration.

**You see.**

- [ ] Identity, sessions, permissions and consumed reads/writes work entirely on Workers and D1 with the baseline's successful and failed outcomes.

**Verify.**

- [ ] Execute retained cases through the planned `bun run test`. Pass when their real source and D1 dependencies execute, rather than mocked replacement queries or a legacy PostgreSQL server.
- [ ] Replay `D_AUTH`, `D_ONBOARDING` and consumed query/write cases with identical synthetic state. Pass when HTTP, session projections, changed rows, rollback and guards match the baseline.
- [ ] Run the owned `bun run test` cases and direct failure/concurrency probes at each changed write boundary. Pass when atomicity and contention outcomes match the original contract, without adding stronger global booking guarantees.

## Phase 3. Complete public booking and organizer workflows

**Build.**

- [ ] Complete public user/event pages, availability, booking submission, success, confirmation, payments, seats, reschedule and cancellation.
- [ ] Complete signup, onboarding, event types, schedules, date overrides, booking lists, settings and app installation.
- [ ] Migrate only consumed query, auth, transport and transactional prerequisites with each complete flow. Unrelated package work does not block it.
- [ ] Preserve the latest upstream notification behavior when all calendar/video integrations fail, including warning details and email suppression settings.

**You see.**

- [ ] A new organizer configures an event and schedule. A visitor books, confirms when required, reschedules and cancels. Organizer actions and failures retain their original effects.

**Verify.**

- [ ] Run the migrated inherited Playwright journeys with the planned `bun run e2e`. Pass when they target the built vinext Worker and reach the same URLs, UI and persisted states as the baseline.
- [ ] Replay `D_BOOKING`, `D_AVAILABILITY`, `D_EVENTS`, `D_BOOKINGS`, `D_SETTINGS`, `D_APPS` and `D_PAYMENTS`. Pass when every owned transition has equivalent success, denial, invalid input, post-write failure and provider effects.
- [ ] Follow `docs/porting/verification.md` to capture original desktop/mobile, light/dark, loading/empty/error and representative locale states. Pass when original markup, copy, styles and interactions remain equivalent. Screenshots alone do not accept behavior.

## Phase 4. Complete delivery, jobs, v2 and remaining product surfaces

**Build.**

- [ ] Accept every app-store integration separately, including credential format, enablement, refresh, callbacks, payloads, signatures, failure mapping and link-only catalog behavior.
- [ ] Replace consumed Trigger, Bull and Redis hosting with selected Cloudflare job/state adapters. Preserve attempt accounting, TTL, throttling, ordering and source-swallowed failures.
- [ ] Bind existing product schedules to Worker dispatch with exact method, authorization and calendar predicates. Do not invent jobs for absent-handler declarations.
- [ ] Replace the v2 Node host at `apps/api/v2/src/worker.ts`, retaining controller/service folders, version selection, DTOs, guards, filters, pagination and public `/api/v2` routes.
- [ ] Complete mail, webhooks, social PNGs, embeds, all locales and docs at their bound Cloudflare destinations.

**You see.**

- [ ] Every in-scope API and delivery path works on Cloudflare. Independent booking, payment, provider and email states retain their original ordering and partial failures.

**Verify.**

- [ ] Execute retained v2 cases with the planned `bun run --cwd apps/api/v2 test:e2e`. Pass when they target the Worker adapter and preserve original endpoint/version/validation/permission contracts.
- [ ] Replay `D_JOBS`, `D_API`, `D_EMBEDS`, `D_DOCS` and each integration row. Pass when signed requests, receiver records, retry/exhaustion, queue/cache behavior, embed messages, content URLs and final rows match the baseline.
- [ ] Compare planned `bun run --cwd apps/api/v2 generate-swagger` output with the baseline. Pass when no in-scope path, method, version, schema, required field or response difference remains unexplained.

## Phase 5. Complete authorized release acceptance

**Build.**

- [ ] Confirm the deployment account has Cloudflare Workers Paid, then complete resumable setup, D1 migrations, resource bindings, secret provisioning and deployment documentation.
- [ ] Prepare the exact release procedure and request separate operator authorization before deployment or real-provider access.

**You see.**

- [ ] A fresh authorized Cloudflare installation runs the full product. A real booking reaches the enabled provider and separate guest inbox.

**Verify.**

- [ ] Execute the planned `bun run setup` under the deployment grant. Pass when fresh installation and interruption recovery succeed without touching unrelated databases or exposing secrets.
- [ ] Run planned `bun run e2e` against the authorized deployment and measure the documented release workload. Pass when actual provider delivery, persistence, limits, recovery and operating measurements have evidence.

## Close the plan

- [ ] Account for every inventory row, behavior domain, external gate and approved deviation with specific evidence.
- [ ] Report specification completeness, implementation completeness, local parity, real provider delivery and deployed acceptance separately.
- [ ] Preserve baseline behavior, including source defects and community-edition stubs, unless a separate product change is authorized.

## Release workload

Measure separate synthetic runs with 5 and 10 bookings per day, one organizer, three connected calendars, five event types and two schedules.
Include a 31-day availability window with 1,000 busy events, date overrides and a daylight saving time change.
Include 100 daily visitor sessions, up to three reschedules and two cancellations, background jobs, a provider outage/recovery and twelve months of retained booking data.
Record requests, CPU, D1 reads/writes, storage, provider outcomes and recovery over one week, then project a month.
This is a release measurement, not permission to deploy or use real customer data.
