# Vinext architecture contract

This reference binds the non-enterprise Cal.diy port at `e8afecd163cd3a0a3ff279bd4721aa7f073c4685`.
[Plan](plan.md), [behavior](behavior.md), [contribution guidelines](../../CONTRIBUTING.md), and [source map](inventory/source-map.tsv) define scope, acceptance, and ownership.

## Evidence and stack

Observed facts below come from pinned source, official documentation, or registry metadata checked on 2026-11-04.
Selected decisions bind future implementation. Neither source inspection nor package availability proves whole-product compatibility.
Product builds, authentication flows, provider delivery and deployed behavior require their own execution evidence.
Cloudflare recommends [vinext for Next.js applications][cf-next] and identifies its beta status. Vinext remains selected.

Prefer compatible upstream releases over local dependency patches. The versions below record the tested stack and may change when the consumed contracts and checks pass. Commit the resulting Bun lockfile so installs remain reproducible.

| Responsibility | Selected version and rule |
| --- | --- |
| Installer and scripts | Bun `1.4.4`. Node `24.22.0` for build tools whose engine contracts require Node. Neither becomes an application host. |
| Framework | `vinext` `1.4.2`, `@vinext/cloudflare` `1.3.2`, Vite `8.3.5`. Keep `next` `16.4.3` for original types, peers, and reference tooling. Production uses vinext aliases and workerd. |
| React | `react`, `react-dom`, and explicit `react-server-dom-webpack` all `19.3.1`. `@types/react` and `@types/react-dom` both `19.3.0`. Upgrade original web React `18.2.0` throughout its consumed graph. |
| React component libraries | `react-select` `5.10.2`, `framer-motion` `11.18.2`, and Emotion `11.14.0` use upstream React 19 declarations. The Emotion resolution requires `^11.14.0`; retain its frozen lock resolution. No local declaration patches. |
| Vite peers | `@vitejs/plugin-rsc` `0.5.38`, `@vitejs/plugin-react` `6.2.1`. The latter's compiler peers are optional. Do not use `5.1.4`, whose declared Vite peer excludes 8. |
| Deployment plan | Cloudflare Workers Paid is required to deploy Cal.flare. Local development uses workerd and local D1. |
| Cloudflare tools | `@cloudflare/vite-plugin` `2.0.0-beta.v.11`, `cf` `1.0.0-beta.27`. Plugin v2 is under npm `beta`; npm `latest` resolves v1 `1.67.0`. |
| Cloudflare runtime | Compatibility date `2026-11-04`, `nodejs_compat`. Plugin v2 resolves Miniflare `5.20261103.0-beta`; cf resolves `5.20261101.0-beta`. Generated runtime types plus `@cloudflare/workers-types` `4.20260702.1` satisfy existing D1/Sentry type peers. Lock both tool graphs. |
| Database | `prisma`, `@prisma/client`, and `@prisma/adapter-d1` all `6.16.3`. Preserve `@calcom/prisma` as domain access boundary. |
| Authentication | Self-hosted `better-auth` `1.7.15`; schema CLI package `auth` `1.7.15`. Native D1 binding, no hosted Better Auth service. |
| Auth primitives | Retain `bcryptjs` `2.4.3`, `otplib` `12.0.1`, and existing encryption and JWT helpers. Better Auth's default password and MFA formats are not selected. |
| Translation | Retain `i18next` `23.2.3`, `react-i18next` `12.3.1`, original JSON, namespaces, and keys. Replace `next-i18next` `15.4.2` loading boundary. |
| v2 HTTP | `hono` `4.13.16` for a Fetch Worker dispatcher. Retain source DTO, service, guard, error, and validation contracts. |
| Cache | `@vinext/cloudflare` Response Store adapter, self-contained mode. Its exact dependency is `@cloudflare/workers-response-store` `1.1.5`. |
| Styling | Retain Tailwind CSS `4.1.17`, PostCSS `8.5.6`, `@tailwindcss/postcss` `4.1.15`, source CSS, classes, and component systems. `vite-css-modules` `1.16.1` handles consumed CSS Modules. |
| Source async runner | `@trigger.dev/sdk` `4.5.4` is observed upstream, not selected for hosting. Its consumed jobs move to D1/Queues/DO scheduling; no Trigger-hosted or Node worker remains. |
| RPC | Retain tRPC packages, including `@trpc/next`, at `11.0.0-next-beta.222`; TanStack Query `5.17.19`, SuperJSON `1.9.1`, Zod `3.25.76`. |
| Docs | Source Next range is `^15.5.28`; target uses vinext and the React/Next peer pins above. Retain Nextra and `nextra-theme-docs` `4.6.1`, `@mdx-js/mdx` `3.1.1`, Pagefind `1.5.2`. Replace only Nextra's webpack loading boundary with a vinext build integration. |
| Delivery and errors | Retain Nodemailer `7.0.12`, Handlebars `4.7.10`, OG `@vercel/og` `0.6.3`. Select `@sentry/cloudflare` and browser `@sentry/react` both `10.75.2`. |
| Checks | Retain Biome `2.3.10`, TypeScript `5.9.3`, Playwright `1.57.0`, Vitest `4.1.8`, and inherited test ownership. Select `@testing-library/react` `16.3.3` and `@testing-library/dom` `10.4.2` for React 19. |

[Vinext metadata][npm-vinext], [Cloudflare adapter metadata][npm-cf-adapter], [plugin v2 metadata][npm-vite-cf], [cf metadata][npm-cf], and [Node release index][node-index] establish framework and engine pins.
[Better Auth metadata][npm-ba], [Prisma D1 metadata][npm-d1], [Hono metadata][npm-hono], and [pinned web manifest][pin-web] establish the other selected boundaries.
Exact-version registry reads succeeded for the new pins. No registry-unavailability blocker remains. A fresh install, peer audit, and Worker import probes remain unexecuted.
Better Auth carries its own Zod 4 and JOSE 6 dependencies. Keep domain Zod 3 and JOSE 4 consumers scoped to their original packages.
No Astro adapter, `@calflare/runtime`, Next-import codemod, PostgreSQL adapter, Accelerate, external Redis, Neon, Hyperdrive-to-PG, or Node application server belongs in the target runtime.

## Bun workspaces and lockfile

Bun `1.4.4` handles dependency installation, workspace selection, package commands and CI.
Set the root `packageManager` to `bun@1.4.4` and retain original workspace package names and `workspace:*` relationships.
Commit one root `bun.lock`; CI and clean-checkout verification use `bun install --frozen-lockfile`.
Preserve retained dependency resolutions while translating upstream overrides, patches and any consumed package-manager behavior.
Review dependency lifecycle scripts explicitly instead of trusting every install hook.
Use Bun package commands, explicit workspace directories and `bunx` for consumed scripts and CI.
Retain Vitest and Playwright. Package-manager migration does not replace test frameworks or change expected behavior.
Retire the former installer, configuration and lockfile once frozen Bun installs and consumed commands pass.
Node remains available only for build tools with a Node engine requirement; it is not the application host.
The [Bun workspace](https://bun.com/docs/pm/workspaces) and [lockfile](https://bun.com/docs/pm/lockfile) contracts govern workspace resolution and frozen installs.

## Folders and runtime ownership

The clean target preserves original paths. A source-map destination is not evidence that the source already runs there.

| Original location | Runtime and responsibility |
| --- | --- |
| `apps/web/app` | Vinext App Router on Workers. Preserve route groups, layouts, templates, loading, errors, not-found boundaries, metadata, RSC, and Server Actions. |
| `apps/web/pages` | Vinext Pages Router and Pages APIs. Preserve `_app`, `_document`, page data functions, catch-alls, API methods, and URLs. |
| `apps/web/modules`, `lib`, `components`, `server` | Keep feature implementations and imports at original paths. Preserve server/client boundaries, provider order, and permission ownership. |
| `apps/web/public`, `styles`, `fonts` | Workers Static Assets and browser assets. Preserve filenames, URLs, CSS order, font weights, variables, and preload behavior. |
| `apps/api/v2/src` | Separate Cloudflare Fetch Worker. Hono replaces Nest Express HTTP hosting. Existing controllers, DTOs, services, and platform code retain their locations. |
| `packages` | Keep workspace names and original feature boundaries. Browser packages import no DB, secret, or Worker-only modules. Server packages receive bindings at their existing boundaries. |
| `packages/prisma` | Complete D1 schema, generated domain client, SQLite SQL migrations, seeds, views or equivalent repository queries, and atomic write plans. |
| `packages/features/auth` | Better Auth instance, Cal auth plugin, projections, provider policy, and numeric-ID mapping. No global framework compatibility package. |
| `packages/i18n` | Original locale JSON and bundled resource lookup. Existing providers in `apps/web/app` retain their placement and public contracts. |
| `packages/embeds` | Original browser build, public namespace, script and postMessage behavior. Output remains under product `/embed/` assets. |
| `apps/docs` | Separate vinext Worker with build-time docs snapshots and Static Assets. Keep `app`, content, theme components, fonts, and URLs. |
| Scripts, tests, examples | Build/test tooling stays outside production request graphs. Examples retain source ownership and do not imply another hosted application. |

Dependency direction stays route or action -> existing feature/service -> repository/provider -> D1 or outbound API.
UI imports browser-safe package entrypoints. `cloudflare:workers` and `env` remain server-only.
`apps/web/vite.config.mts` and `cloudflare.config.ts` own vinext, Cloudflare plugin v2, bindings, and build output.
`apps/api/v2` owns its Fetch entry and matching Cloudflare configuration. Web reaches v2 through a service binding at the original `/api/v2` URL.
Both product Workers share the same authoritative `DB`; docs has no product DB binding.
An implementation move uses `git mv` before edits where a source actually changes location. No blind copy from the Astro port.

## Configuration, routes, and assets

Selected initialization follows the [current vinext migration][vx-migrate] and [Cloudflare deployment guide][vx-cloudflare].
For web, explicit choices are `--platform=cloudflare --cdn-cache=response-store --response-store-mode=self-contained --data-cache=none --image-optimization=none --no-prerender`.
Review initializer output before applying it. Pin the BOM rather than accepting newly resolved tags.
`cloudflare.config.ts` is deployment source of truth. Cloudflare Build Output and `.cloudflare/types` remain generated and ignored.
Scripts use `vite dev`, `vite build`, `vite preview`, `vinext-cloudflare deploy`, and `cf workers types` as documented. Deployment commands remain outside this task's authority.
Preserve generated binding types in type-check inputs. Do not maintain a second hand-edited Wrangler configuration with conflicting settings.
Preserve executable `next.config.ts` headers, redirects, rewrite stages, image configuration, and routing predicates. Translate webpack-only build hooks at their existing config boundary.
Keep supported `next/*` imports. Vinext resolves them through its framework implementation. No call-site wrapper migration is selected.

Pinned [rewrite stages][pin-rewrites] and [proxy matcher][pin-proxy] determine dispatch, rather than a new catch-all router.
Preserve headers and redirects, proxy behavior, `beforeFiles`, static/literal resolution, `afterFiles`, dynamic resolution, and fallback order.
Keep query merging, duplicate values, host predicates, reserved names, onboarding exception, org domains, single-org mode, and original status codes.
`/forms`, `/success?uid=`, `/cancel`, `/login`, `/embed.js`, avatar routes, and `/api/v2` retain their visible URLs and ordered rewrites.
Proxy retains signup-disable `503`, return-to handling, logout deletion, embed headers, CSP nonce generation, and its exact matcher coverage.
Replace its [Vercel Edge Config lookup][pin-edge] with D1 `RuntimeConfig(key TEXT PRIMARY KEY, valueJson TEXT)` for `isSignupDisabled`, preserving missing-key and error behavior.
Pages APIs retain method dispatch, raw-body access, parser configuration, limits, cookies, redirects, and repeated `Set-Cookie`. Webhook verification receives unchanged bytes.
App Route Handlers retain named HTTP exports and unsupported-method behavior. Server Actions retain authorization, form/error results, redirects, and revalidation.
Hard loads and client navigation retain provider order, boundary placement, metadata, scroll, and hydration behavior. Server Actions remain server functions, not replacement REST features.
Original tRPC Pages handlers and `createTRPCNext` stay under vinext. Preserve split endpoints, `skipBatch`, SuperJSON, SSR disabled state, retry rules, and `1000` ms stale time from [the client][pin-trpc].

Static Assets uses `htmlHandling: "none"`, `notFoundHandling: "none"`, and `runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"]`.
The original 39,079,898-byte Salesroom video exceeds the 25 MiB individual Static Asset limit.
Its generated upload copy becomes two parts of at most 20 MiB; source files and the original public URL remain in place.
A request-scoped `ASSETS.fetch` adapter assembles that resolved public file after native middleware dispatch, preserving bytes, stat validators, conditional requests, ranges and `HEAD`.
Final Worker response framing uses `FixedLengthStream`; generated parts remain Static Assets and require no additional storage binding.
These [documented patterns][vx-cloudflare] preserve middleware before public files and let hashed build output bypass the Worker. Removing either exclusion can break scripts and CSS.
Preserve both favicon sources and the pinned route winner. No missing asset, reserved route, or API path becomes a username page.
Keep `next/font` calls through vinext initially. Verify CalSans and Inter bytes, glyphs, metrics, preload, and CSS variables against [the root layout][pin-layout].
Keep `images.unoptimized = true`; select no Cloudflare Images resource. Dynamic avatar, logo, and OG routes still produce their original bytes, headers, and errors.
OG retains `@vercel/og`'s edge implementation where vinext's alias needs it. Acceptance requires decoded PNG output, dimensions, fonts, ETag, and conditional-response behavior.

## Cache and middleware semantics

Selected web cache is `responseStoreAdapter({ mode: "self-contained" })` with matching `createWorkersResponseStoreSelfContainedConfig()`.
The [native adapter][vx-cache] owns its required R2 cache-body bucket, SQLite DO metadata, generated exports, cache policy, and version bindings.
This source-backed need includes [membership][pin-cache] and travel-schedule caches, `NEXTJS_CACHE_TTL = 3600`, and `revalidateTag(tag, "max")` stale semantics.
D1 remains authoritative for product records. R2 here stores disposable cached responses/data, not product uploads or replacement relational records.
Keep source cache arguments, user IDs, tags, lifetimes, revalidation, and failure fallback. Do not replace cached authorization data with a global value.
Root layout already reads headers/cookies at the pin. Explicit `dynamic = "force-dynamic"` there makes request-specific web rendering visible before cache lookup.
Preserve dynamic Route Handler classification separately. Auth, personalized data, org/host-specific output, and query-dependent responses must not enter shared response storage.
Middleware and routing run before cache selection. Compare HTML and RSC variants, rewrites, locale, query, and host behavior independently.
Vinext documents differences in client-navigation classification, `generateStaticParams`, metadata streaming, incomplete Cache Components/PPR, fonts, and images in [its differences reference][vx-diff].
Response Store also documents possible HTML/RSC generation skew and a Pages on-demand revalidation limitation. The affected cache boundary needs focused replay before acceptance.
A library API being listed as supported does not waive these checks or imply a framework switch.
No KV cache or general product-upload R2 bucket is selected. Backblaze appears only as a web dependency in the inspected pin, not an observed storage consumer.

## Better Auth and Cal identity

Selected Better Auth `1.7.15` runs inside the web Worker with `database: env.DB`, native D1 support, and no hosted infrastructure dependency.
Pass existing `NEXTAUTH_SECRET` explicitly for signing, keep `CALENDSO_ENCRYPTION_KEY` for encrypted Cal data, and derive public base URL from existing URL configuration. No hosted-service defaults.
[Better Auth's D1 release documentation][ba-d1] documents native binding detection and D1 batch use. [Database mappings/hooks][ba-db] and [plugins][ba-plugins] provide Cal-specific boundaries.
`packages/features/auth` replaces NextAuth server/client imports at auth boundaries. Existing page/provider files consume Cal projections rather than Better Auth's default session response.
Disable stock password sign-in, public stock sign-up, automatic email linking, and stock MFA endpoints where they bypass Cal policy. Cal endpoints create Better Auth sessions only after the existing checks complete.

| Concern | Binding mapping |
| --- | --- |
| Numeric IDs | Keep `users.id` and all domain user foreign keys as integers. `AuthUser.calUserId INTEGER UNIQUE NOT NULL REFERENCES users(id)` maps Better Auth's opaque string user ID one-to-one. Neither ID replaces the other. |
| Auth schema | Separate `AuthUser`, `AuthSession`, `AuthAccount`, and `AuthVerification` tables in the same D1 database. Use Better Auth model names/additional fields. Do not reinterpret Cal `emailVerified DateTime?` as Better Auth's boolean. |
| Domain account | Existing Cal `Account.id` cuid, provider IDs, provider account uniqueness, token fields, and numeric `userId` stay canonical for current consumers. Synchronize protocol account data and mapping in guarded D1 batches. |
| User writes | Original signup/settings services own domain defaults, profile creation, lock state, and email rules. They maintain auth mapping/projection fields in the same write unit. No auth-only orphan user can acquire a session. |
| Session storage | Better Auth signed opaque session cookie plus D1 session record replaces NextAuth JWT wire format. Store the Cal claim snapshot and profile context on `AuthSession`; do not expose opaque auth IDs to domain callers. |
| Browser projection | Preserve `expires`, `profileId`, `upId`, `hasValidLicense=false`, and source `user` fields, including numeric `id`, role, org, username, locale, impersonation, and inactive-admin reason. |
| Server projection | Preserve DB/profile enrichment, numeric `id`, UUID, verification fields, onboarding state, avatar, org/profile context, impersonator lookup, and token-validity expiry. Pinned server license stub yields `true`, unlike browser callback. |
| Lifetime | Effective validity is 30 days unless truthy `metadata.sessionTimeout` overrides it in minutes. Persist that validity on `AuthSession.expiresAt`. Preserve the separate browser `expires` and cookie expiry calculation of 30 days. |
| Renewal | Disable Better Auth automatic refresh and cookie cache. Cal session endpoint renews validity and response cookies using the pinned rules. RSC/server lookup validates but does not refresh. Never accept an expired session because its browser expiry is later. |
| Session updates | Preserve source `profileId`, `upId`, locale, name, username, and email updates. Preserve role/permission derivation and profile ownership checks; package defaults cannot promote roles. |
| Credentials | Reuse source email lookup, locked-user rejection, limiter order, password-required branch, and bcrypt verification. Keep `UserPassword.hash`; new hashes use source bcrypt cost `12`. No automatic scrypt rehash. |
| MFA/recovery | Retain encrypted 32-character TOTP secret, otplib validation, source errors, backup-code hyphen stripping, and one-use nulling/re-encryption. Preserve source consumption and its concurrency limits; do not claim a stronger one-use guarantee than the baseline provides. Retain setup/disable/password-reset routes and policies. |
| Admin | Preserve source password policy, 2FA requirements, dev/E2E exceptions, `INACTIVE_ADMIN`, and reason values `both`, `password`, `2fa`. Cal permission checks stay at every page/action/procedure boundary. |
| Google | Better Auth Google protocol handler with original enablement, offline access, consent, scopes, and verified-email policy. Cal sign-in service retains user creation/linking, org autolink, calendar/Meet setup, and photo effects. |
| Microsoft | Better Auth generic OAuth provider registered as `azure-ad`. Preserve tenant/issuer endpoints, scopes, `xms_edov` accepted values, profile handling, Outlook installation, and stored token expiry units. |
| OAuth linking | Keep source identity-provider/account lookup, case behavior, legacy identity-ID repair, email-change branch, and verified-email merge policy. Stock global trusted-provider linking cannot replace these branches. |
| OAuth MFA | Preserve `/auth/login?totp=<signed-token>` challenge before a full session. Retain source HS256 issuer/audience and `2m` expiry. OAuth success alone cannot bypass source second-factor handling. |
| Email link | Cal plugin retains provider `email`, existing verification repository/template, callback URL, expiry, and replay behavior. Executable `10 * 60 * 60` means 10 hours, despite the pin's "10 min" comment. |
| URLs/errors | Keep `/api/auth`, public sign-in/callback/session/sign-out paths, `/auth/login`, `/auth/logout`, `/auth/error?error=`, `/auth/verify`, and existing signup/reset URLs. Translate to Better Auth inside that owned boundary. |
| Redirects | Preserve relative callback resolution, WEBAPP_URL hostname comparison, base-URL fallback, error codes, and provider failures. Pin compares hostnames, not strict origins. Do not silently tighten this during the port. |
| Cookies/origins | Preserve HTTPS Secure/HttpOnly policy, session cookie name, `NEXTAUTH_COOKIE_DOMAIN`, path `/`, HTTPS `SameSite=None`, and dev `Lax` where source specifies them. Preserve callback/CSRF/state/PKCE/nonce handling and explicit public origins; never disable CSRF checks. |

The [auth options][pin-auth], [server helper][pin-session], [cookie policy][pin-cookies], [schema][pin-schema], and [NextAuth 4.24.15 source package][npm-nextauth] bind these mappings.
Browser and server session projections differ at the pin. Unifying license, expiry, or enriched fields requires a separately approved behavior change.
Fresh D1 starts with synthetic seeds and fresh sessions. Existing JWT cookies are not asserted readable by Better Auth, and this specification does not migrate private users or sessions.
Focused acceptance covers credential errors, lock/rate limit, TOTP and backup reuse, per-user validity/renewal, both projections, logout, profile changes, linking conflicts, OAuth MFA, and repeated cookies.
Real provider callbacks require registered public URLs and authorized credentials. Stored SAML enum references remain source data; no new enterprise or hosted SSO service is selected.

## i18next loading and isolation

Retain translation JSON and keys from `e8afecd` in `packages/i18n`, including `common`, English fallback, and `zh -> zh-CN` behavior. Do not restore keys removed upstream from the old pin.
Replace filesystem-backed `next-i18next` loading with a build-generated static import map of the same JSON. No runtime filesystem or translation SaaS is required.
Use i18next `createInstance()` for each SSR request and React `I18nextProvider` at existing provider boundaries. Cache immutable resource dictionaries, not mutable request language instances.
Initialize before rendering. Serialize the selected locale, namespaces, resources, and fallback configuration so the first browser render uses the same messages.
Preserve `useLocale`, custom/Atoms context precedence, readiness, interpolation, escaping, RTL, document `lang`/`dir`, and explicit locale switches.
Locale precedence is entrypoint-specific. [Root getLocale][pin-locale] prefers session locale, then parses the first Accept-Language preference and BCP-47 lookup.
[API getLocaleFromRequest][pin-api-locale] prefers session locale, then `parser.pick(..., { loose: true })`, then configured default. Do not replace both with one new precedence rule.
Preserve page-specific query/router locale overrides where their original caller applies them. Do not introduce a universal cookie or browser-language override.
[Original resource loading][pin-i18n] maps unsupported resource locales to English and merges English first. Root language selection can differ from that resource fallback.
[Official resource loading][i18next-load] and [I18nextProvider][react-provider] support this boundary replacement. They do not change Cal's locale policy.
Acceptance compares SSR and hydration in concurrent locales, missing keys/namespaces, Chinese fallback, region matching, RTL, locale updates, and email locale selection.

## Full D1 schema and atomicity

### D1 and Prisma usage

D1 replaces PostgreSQL as the authoritative relational database. Prisma remains the application's normal domain data-access layer.
Use `prisma`, `@prisma/client` and the official `@prisma/adapter-d1` at the same pinned version, `6.16.3`.
The [official D1 connector documentation](https://www.prisma.io/docs/orm/v6/overview/databases/cloudflare-d1) requires the SQLite provider and D1 adapter.
Application runtime connects through `PrismaD1(env.DB)`, not a PostgreSQL URL or connection pool.

| Operation | Selected access path and ownership |
| --- | --- |
| Ordinary domain reads and compatible writes | Existing `@calcom/prisma` client and repository methods. Keep field selection, extensions, DTOs and caller-visible results. |
| PostgreSQL-specific reads/filters | Translate at the existing query owner to compatible Prisma operations or parameterized SQLite raw queries. Native D1 reads are limited to contracts or metadata the adapter cannot provide. |
| Required atomic multi-statement writes | Prepared, bound statements in one native `DB.batch()` through the existing repository boundary. Shared binding/batch plumbing belongs in `packages/prisma`; domain SQL and result mapping stay with their current owner. |
| Bulk/upsert/nested writes | Inspect the emitted statements and required source guarantee. One Prisma call is not evidence of one SQL statement or an atomic unit. Use a guarded native batch when multiple statements must commit together. |
| Schema and generated domain types | Keep `packages/prisma/schema.prisma` as the domain model source, with `provider = "sqlite"` and the Worker-compatible client generator. Adapt unsupported fields/queries in place. |
| Database changes | Reviewed SQLite SQL in `packages/prisma/migrations-d1/`, applied by the D1 migration runner with one history. Prisma generation and `migrate diff` are build tools, not a separate production migration authority. |
| Better Auth records | Its selected native D1 integration owns the separate auth-table format in the same database. Include its generated schema changes in the same reviewed D1 migration sequence; do not auto-migrate at request startup. |

Keep the named and default Prisma exports, `customPrisma`, `readonlyPrisma`, existing selects and extension contracts.
The target `readonlyPrisma` reads the same D1 database. URL-based custom clients cannot create an external database path; reconcile those consumers with the selected binding.
Preserve existing repository/service placement rather than moving untouched calls merely to standardize architecture.
Native SQL must retain the effects of the locked-user, pending-payment, booking-idempotency and undefined-filter guards where those contracts apply.
Generated client types follow the converted schema; preserve domain-facing values without hand-editing generated output or disguising incompatible filters.

The [6.16.3 Worker adapter](https://github.com/prisma/prisma/blob/6.16.3/packages/adapter-d1/src/d1-worker.ts#L98-L112) has no-op transaction commit/rollback methods.
Its [transaction implementation](https://github.com/prisma/prisma/blob/6.16.3/packages/adapter-d1/src/d1-worker.ts#L160-L178) warns that implicit and explicit transactions execute as individual queries.
Do not rely on `$transaction`, an interactive callback or a nested create to preserve the source's all-or-nothing multi-row behavior.
D1's native `batch()` is the atomic path. Put required guards and dependent writes inside that batch, not in a separate Prisma call before it.
Verify failure rollback, generated relationships, defaults, extension-produced values and relevant simultaneous requests for each migrated write boundary.

Every in-scope relational model, join, unique constraint, foreign key, default, index, enum value, and persisted feature belongs in D1.
No partial booking-only database, external PostgreSQL, or second authoritative relational store is selected.
Prisma uses `engineType = "client"`, a Workers-compatible generated module, and `PrismaD1(env.DB)`. Retain extension/select contracts and package exports.
`readonlyPrisma` uses the same D1 boundary. No read replica is assumed. Cross-request consistency claims require their own evidence.

| Source representation | Selected D1 contract |
| --- | --- |
| `Int` IDs | SQLite integer keys and original autoincrement behavior. Keep existing seed/import IDs, compound keys, public UIDs, and user UUIDs. No universal rekeying. |
| Money | Original integer amount/fee units plus currency. No float conversion. |
| `DateTime` | Domain API returns JS `Date`. Prisma D1 `6.16.3` serializes UTC ISO text with milliseconds and `+00:00`. Raw domain SQL and SQL date defaults use that exact representation, including `strftime` defaults rather than mixed `CURRENT_TIMESTAMP` text. REST and provider epoch conversions remain field-specific. |
| Auth dates | Better Auth owns serialization in its separate tables. Cal projections convert explicitly; do not mix auth booleans/date formats with domain columns. |
| JSON/null | Preserve arrays/objects, enum strings, missing values, SQL null, JSON null, and Prisma null sentinels at the existing boundary. |
| Scalar lists | Convert all nine list fields to JSON columns: six scalar lists and the three enum lists `Webhook.eventTriggers`, `App.categories`, and `AccessCode.scopes`. Rewrite predicates/order with bound SQLite JSON SQL. Preserve domain-facing list types. |
| PostgreSQL features | Replace native annotations, casts, functions, aggregates, case-insensitive comparisons, null ordering, sequences, and raw queries with explicit SQLite equivalents. Preserve uniqueness semantics. |
| Views | `BookingTimeStatus` and `BookingTimeStatusDenormalized` remain equivalent SQLite view/query contracts for every consumer. Removing Prisma view declarations cannot remove behavior. |

[Pinned schema][pin-schema] defines source types. [The exact D1 adapter package][npm-d1] establishes date serialization, not query equivalence.
`packages/prisma/migrations-d1/` owns ordered SQLite SQL migrations for the complete domain and auth schema. `packages/prisma/schema.prisma` remains the domain generator input. The same package owns synthetic seeds and migration-history handling.
PostgreSQL auto-migrations and Docker DB setup leave the target execution graph. Original history remains available. No destructive live-data reset is authorized.
Use Prisma generation for client/enums/Zod output and `prisma migrate diff` to produce domain SQL for review. Auth schema output is reviewed into the same ordered SQL sequence.
The pinned `cf` runner applies each SQL file plus its `_calflare_migrations` history insert through `cf d1 raw --batch @<generated.json>`; `--local` targets synthetic D1. Its local explorer does not implement the `d1 query` endpoint.
Migrations and both product Workers must share the SDK-resolved local DB ID `DB-calflare-web` and persistence root `apps/web/.cloudflare/state` with SDK storage under `v3`; future v2 configuration must preserve both. Remote migration requires separate authorization. No PostgreSQL `prisma migrate deploy` runs.
Dependent writes and former interactive `$transaction` callbacks become guarded `DB.batch()` statements at their existing repositories.
[Cloudflare documents batch rollback on failure][d1-batch]. Independent calls, earlier reads, provider HTTP requests, and later queue sends are not part of that transaction.
Use SQL subqueries and stable unique keys for dependent generated IDs. `RETURNING` collects committed results; it does not feed JavaScript results into a later prebuilt statement.
Required-row predicates use constraints or explicit SQL guards that fail the batch. A zero-row update alone is not a rollback signal.
Preserve caller-visible touched-row counts and Prisma error mappings, including `P2002`, `P2003`, and `P2025`.
Auth mapping/account writes use the same discipline. Better Auth's native D1 support does not prove custom hooks compose into one atomic operation.
Where source semantics require durable DB-to-Queue handoff, commit delivery state with the domain change, then send/retry idempotently. Preserve provider idempotency where available.
Acceptance covers every converted query family, null/date/list round trips, FK/cascade behavior, uniqueness, views, later-statement rollback, and concurrent guarded writes.
No cross-provider transaction, exactly-once effect, or stronger global double-booking guarantee is claimed.

## Jobs, ephemeral state, and integrations

The v2 Worker owns `scheduled` and `queue` handlers and the application `RUNTIME_STATE` DO class. Shared job services stay in original packages.
One UTC minute dispatcher evaluates product rows from [schedules](inventory/schedules.tsv), including source calendar conditions and monthly last-day guards.
Existing cron URLs retain methods and authorization. Repository-maintenance schedules and `no-product-handler` rows create no new product job.

| Binding | Selected responsibility and source need |
| --- | --- |
| `DB` | Complete domain/auth records, existing Task records, and required delivery state. Same database for both product Workers. |
| `ASSETS` | Each app's own public files, fonts, embed output, and built assets. |
| `API_V2` | Web-to-v2 service binding. Preserve public `/api/v2` transport without a Node host or external app server. |
| `JOBS` | Cloudflare Queue replaces consumed Bull and Trigger submission, including `calendars/default_calendars_job` with numeric `userId`, booking notifications, calendar setup, and webhook delivery. |
| `RUNTIME_STATE` | SQLite DO per logical cache/limiter namespace replaces consumed Redis operations and application rate-limit state. Preserve keys, lists, TTLs, atomic counters, invalidation, and failure results. |
| Response Store bindings | Native helper-owned DO and R2 cache-body bindings, distinct from `RUNTIME_STATE`. No provider credentials or authoritative product records belong in this cache. |

[Task repository][pin-tasker] preserves due ordering, `take: 1000`, attempt increments, retry interval, max attempts, cancellation, and success. Its cleanup is a no-op at the pin.
Task retries and transport retries remain separate. Queue redelivery must not double-increment a completed Task or blindly repeat a successful provider effect.
[Tasker][pin-tasker-select] retains explicit async opt-in, sync fallback, and returned run IDs. Map effective source configuration to Cloudflare configuration; missing async configuration remains synchronous.
Replace Trigger `schemaTask`, `.trigger()`, consumed run options, and loggers at existing tasker boundaries. D1 stores run/attempt/due/cancellation state; Queues transports work; DO admission/alarms preserve queue concurrency and subsecond retry scheduling.
Source [notification config][pin-trigger-notify] sets concurrency 20 and 3 attempts with randomized 500 ms to 30 s backoff; calendar config sets concurrency 10 and 60 to 300 s, webhooks 25 and 30 to 600 s. Preserve each task's factor, payload, schema, and retryable errors.
Trigger machine/OOM tier escalation has no literal Workers equivalent. Job memory/CPU fit and retry timing remain focused acceptance limits; no external compute fallback is selected.
[Calendar processor][pin-processor] catches provider failures and resolves; preserve that terminal branch. Do not convert it into a retry because Queues permits retries.
[Calendar cache][pin-calendar-cache] retains key `apiv2:user:<id>:calendars` and `10_000` ms TTL. [Redis service][pin-redis] separately uses milliseconds for set TTL and seconds for expire.
Also replace direct `.redis` consumers, not only service methods. [OAuth token cache][pin-token-cache] requires hashes, `expireat`, and `setex`; roles/timezones use direct `EX` caches. Tokens remain authoritative in D1.
Web [rate-limit policy][pin-limit] keeps source namespaces/windows, ban-list branch, missing-`UNKEY_ROOT_KEY` disabled branch, 5-second fail-open policy, and response shape while DO replaces external limiter storage.
Existing deployment configuration must explicitly preserve enabled/disabled state; provisioning a DO does not enable previously disabled limiting.
Queue acknowledgement, retry, and deduplication must follow source terminal/retryable outcomes. [Cloudflare Queues can redeliver][queues-delivery].

Each [integration row](inventory/integrations.tsv) retains slug, catalog metadata, enablement, credential schema, scopes, callbacks, selected calendars, effects, and errors.
Keep SDK versions where Worker imports/networking work. Replace unsupported transport inside existing provider modules with Fetch/TCP to the same provider contract.
Preserve Google refresh/watch flows, Microsoft Graph and expiry units, CalDAV discovery/XML/recurrence, payment minor units/signatures, and webhook raw bytes.
Web Stripe `9.16.0` and v2 Stripe `15.4.0` remain separate source versions. Browser SDKs remain client-only.
Mail keeps original templates, copy, locale, attachments, ICS, headers, kill switch, and swallowed-failure behavior.
The new baseline sends notifications despite all integration results failing in [regular booking][pin-booking-mail] and [confirmation][pin-confirm-mail], subject to existing mail/dry-run/seated-reschedule gates. Preserve `appsStatus` failure/error/warning aggregation; do not restore the old suppression branch.
[Transport selection][pin-mail] remains Resend SMTP, `EMAIL_SERVER`, configured host, then local sendmail. Select public TLS/STARTTLS SMTP on Workers, preserving that selection order.
[Workers TCP][cf-tcp] provides TLS/STARTTLS sockets but blocks port 25 and restricted destinations. It does not certify Nodemailer. Probe its socket path and adapt only that transport if needed.
Local sendmail has no Workers executable and is an explicit configuration blocker. Real inbox/provider effects remain separately authorized external acceptance.
Cloudflare-only hosting/storage does not remove original third-party calendar, payment, mail, SMS, or analytics APIs. Private-network-only integrations need a supported Cloudflare path or a recorded compatibility blocker.

## v2, docs, configuration, and checks

[Hono Workers dispatch][hono-workers] preserves every consumed controller method/version at `apps/api/v2/src`. Explicit service composition replaces Nest Express bootstrap and background processes.
Keep original DTO transformation/whitelisting, decorators/validators, guard order, response interceptor, pagination, cache, throttling, and error filters.
[Bootstrap][pin-v2] selects a supported `cal-api-version`, otherwise `2024-04-15`; preserve that fallback, CORS, optional global prefix, and validation error bodies.
[App module][pin-v2-module] binds raw webhook parsing, URL-encoded OAuth token parsing, request IDs, logging, root aliases, and rewrite order.
Keep `/api/v2/health` separate from `/api/health`, root `/v2` aliases where configured, signed billing bodies, and platform OAuth token semantics.
Do not replace DTO errors with generic Zod envelopes or expose default Hono error bodies. Compare retained controller e2e cases and generated OpenAPI methods, versions, schemas, and statuses.

Docs keeps [the pinned catch-all page][pin-doc-page], layout, theme components, `_meta.ts` navigation, content, anchors, fonts, Callouts, and extensionless URLs on its own origin.
Use Nextra `4.6.1`'s exported `compileMdx` at build time with its existing MDX/theme behavior. A build manifest supplies page imports, page map, metadata, TOC, and static params to existing entries.
Nextra's webpack plugin is not asserted portable. Replace that loading boundary; retain Nextra React components and `mdx-components.tsx` rather than rewriting the site shell.
Docs selects vinext Static Assets response caching with all docs paths prerendered, no data cache, and no image optimization. Pagefind indexes final rendered HTML into `public/_pagefind`.
[Nextra exports][npm-nextra] and [pinned dispatcher][pin-doc-page] establish inputs, not an executed Vite integration. The docs slice must compile every page and compare navigation/search/theme output.

Worker bindings/secrets supply server configuration. Preserve consumed variable names, defaults, feature flags, `NEXTAUTH_URL`, public web/API URLs, org mode, and provider enablement.
Only an explicit public-build allowlist exposes consumed `NEXT_PUBLIC_*` values. Never mutate global `process.env` per request or serialize bindings into props.
Local `.dev.vars` stays ignored. Generated `Env` files contain types, not values. Logs preserve request IDs/error classes with credentials, cookies, and private payloads redacted.
Retain per-route HTTP errors, tRPC formatting, v2 filters, and source log behavior. Sentry Worker wrapping observes failures without changing public responses.

Target CI uses frozen Bun install, generated D1/auth schema checks, type/lint checks across consumed workspaces, production vinext/v2/docs builds, and relevant retained unit/integration/browser cases.
Connect existing runners to built workerd and fresh synthetic D1 before treating green results as port evidence. Keep inherited tests and strict main checks intact.
Focused probes cover auth projections/expiry, i18n isolation, raw bodies, route precedence, Server Actions/hydration, cache variants/invalidation, D1 rollback, Queue redelivery, and DO TTL/counters.
A complete-product prototype, deployment, or paid resource is not a prerequisite for beginning implementation. Each slice proves its concrete boundary and records remaining external gates.
Release verification records compressed bundle, CPU, memory, subrequests, D1 workload/parameters, migrations/recovery, and provider effects against current account limits.
Specification completeness, local behavior, live provider delivery, and deployed acceptance remain separate results. Selected decisions do not establish implementation acceptance.

[cf-next]: https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
[vx-migrate]: https://vinext.dev/docs/getting-started/migrating
[vx-cloudflare]: https://vinext.dev/docs/deploying/cloudflare
[vx-diff]: https://vinext.dev/docs/reference/differences
[vx-cache]: https://vinext.dev/docs/guides/caching
[npm-vinext]: https://registry.npmjs.org/vinext/1.4.2
[npm-cf-adapter]: https://registry.npmjs.org/@vinext%2fcloudflare/1.3.2
[npm-vite-cf]: https://registry.npmjs.org/@cloudflare%2fvite-plugin/2.0.0-beta.v.11
[npm-cf]: https://registry.npmjs.org/cf/1.0.0-beta.27
[node-index]: https://nodejs.org/dist/index.json
[npm-ba]: https://registry.npmjs.org/better-auth/1.7.15
[npm-d1]: https://registry.npmjs.org/@prisma%2fadapter-d1/6.16.1
[npm-hono]: https://registry.npmjs.org/hono/4.13.16
[npm-nextauth]: https://registry.npmjs.org/next-auth/4.24.15
[npm-nextra]: https://registry.npmjs.org/nextra/4.6.1
[ba-d1]: https://better-auth.com/blog/1-5#cloudflare-d1-support
[ba-plugins]: https://better-auth.com/docs/concepts/plugins
[ba-db]: https://better-auth.com/docs/concepts/database
[hono-workers]: https://hono.dev/docs/getting-started/cloudflare-workers
[i18next-load]: https://www.i18next.com/how-to/add-or-load-translations
[react-provider]: https://react.i18next.com/latest/i18nextprovider
[d1-batch]: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
[queues-delivery]: https://developers.cloudflare.com/queues/reference/delivery-guarantees/
[cf-tcp]: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
[pin-web]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/web/package.json
[pin-layout]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/web/app/layout.tsx#L1-L24
[pin-rewrites]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/web/next.config.ts#L260-L369
[pin-proxy]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/web/proxy.ts#L68-L169
[pin-trpc]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/trpc/react/trpc.ts#L50-L134
[pin-cache]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/web/app/cache/membership.ts#L1-L26
[pin-auth]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/auth/lib/next-auth-options.ts
[pin-session]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/auth/lib/getServerSession.ts#L39-L150
[pin-cookies]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/lib/default-cookies.ts#L15-L72
[pin-schema]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/prisma/schema.prisma
[pin-locale]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/auth/lib/getLocale.ts#L22-L61
[pin-api-locale]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/auth/lib/getLocaleFromRequest.ts#L10-L22
[pin-i18n]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/i18n/server.ts#L29-L80
[pin-tasker]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/tasker/repository.ts#L65-L212
[pin-processor]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/api/v2/src/platform/calendars/processors/calendars.processor.ts#L6-L31
[pin-calendar-cache]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/api/v2/src/platform/calendars/services/calendars-cache.service.ts#L6-L34
[pin-redis]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/api/v2/src/modules/redis/redis.service.ts#L46-L175
[pin-limit]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/lib/rateLimit.ts#L33-L130
[pin-mail]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/lib/serverConfig.ts#L8-L60
[pin-v2]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/api/v2/src/bootstrap.ts#L26-L81
[pin-v2-module]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/api/v2/src/app.module.ts#L86-L124
[pin-doc-page]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/docs/app/%5B%5B...mdxPath%5D%5D/page.tsx#L1-L27
[pin-edge]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/web/proxy.ts#L1-L13
[pin-token-cache]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/api/v2/src/modules/oauth-clients/services/oauth-flow.service.ts#L24-L103
[pin-tasker-select]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/lib/tasker/Tasker.ts#L9-L83
[pin-trigger-notify]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/tasker/trigger/notifications/config.ts#L4-L24
[pin-booking-mail]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/service/RegularBookingService.ts#L2064-L2172
[pin-confirm-mail]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleConfirmation.ts#L88-L121
