# Configure Cal.flare on Cloudflare

The target uses vinext on Workers, with D1 for all application records. The [port plan](porting/plan.md) tracks implementation readiness.
These setup steps apply as the corresponding Bun, Worker and D1 milestones become available.

## Prepare your account and domains

1. Select the Cloudflare account that owns the application Workers and D1 database.
2. Choose the web, API and docs URLs. Web exposes the original `/api/v2` path through the `API_V2` service binding.
3. Set the application URLs consistently, including `NEXT_PUBLIC_WEBAPP_URL`, `NEXT_PUBLIC_WEBSITE_URL`, `NEXT_PUBLIC_EMBED_LIB_URL` and `NEXTAUTH_URL`.
4. Register exact OAuth callback URLs with each enabled provider. Use separate registrations or callback entries for local development and production.

Cloudflare's [vinext guide](https://vinext.dev/docs/deploying/cloudflare) describes the native deployment integration.
The source configuration is `cloudflare.config.ts` beside each app's Vite configuration. Generated build output and binding types stay out of Git.

## Bind resources

| Application | Required resources |
| --- | --- |
| Web | `DB`, `ASSETS`, `API_V2`, auth/provider secrets and the selected Response Store cache bindings. |
| API v2 and jobs | The same `DB`, `JOBS`, `RUNTIME_STATE`, scheduler, and the secrets consumed by its handlers. |
| Docs | Its own Static Assets and configured static response handling; no application DB binding. |

Response Store uses its native helper's DO/R2 resources for disposable cached data. D1 remains authoritative for domain and auth records.
Shared response caching must exclude personalized output, auth responses and request-specific data.
Keep vinext's `runWorkerFirst` patterns and hashed-build-output exclusions so middleware protects public paths without breaking scripts and CSS.
Exact flags, cache policy and binding responsibilities are in [architecture](porting/architecture.md#configuration-routes-and-assets).

## Configure local secrets

Use ignored `.dev.vars` files in each app that consumes secrets. Add only required names; do not copy all server variables into browser build configuration.
Do not use the upstream `.env.example` PostgreSQL URLs as a D1 connection configuration.
D1 is accessed through the `DB` binding, with fresh local state for development.

Generate your own auth and encryption values:

```sh
openssl rand -base64 32
openssl rand -base64 24
```

Use the first value for `NEXTAUTH_SECRET` and the second 32-character value for `CALENDSO_ENCRYPTION_KEY`.
Keep these stable for an installation. Changing encryption keys without a data/key-rotation procedure can make stored credentials unreadable.
`CRON_API_KEY` protects retained cron endpoints. Generate a fresh value rather than reusing an example key.

For deployment, use [Worker secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/).
Nonsecret public URLs and flags belong in configuration; passwords, client secrets, API tokens and signing keys belong in secrets.
Set a consumed secret on both Workers when shared services need it.

## Prepare D1

1. Create a D1 database and bind it as `DB` to web and v2. Use a separate database for each deployment environment.
2. Use `packages/prisma/migrations-d1/` for the converted domain and auth schema.
3. Apply migrations to fresh local D1, then populate synthetic users, schedules, event types and app-store metadata with the ported seed commands.
4. Validate IDs, relationships, defaults, list/JSON fields and timezone/date representation through the real Prisma/D1 boundary.
5. Verify rollback and guarded concurrent writes before accepting booking mutations.

Both Workers must resolve the same local D1 storage identity during development.
PostgreSQL migration commands and the upstream Docker database are not Cal.flare deployment steps.
See [Cloudflare D1 setup](https://developers.cloudflare.com/d1/get-started/) and the [complete D1 contract](porting/architecture.md#full-d1-schema-and-atomicity).

## Configure mail and integrations

Set `EMAIL_FROM` and the selected relay credentials. The retained selection order is `RESEND_API_KEY`, `EMAIL_SERVER`, explicit SMTP fields, then the unsupported local-sendmail fallback.
Use a supported public TLS/STARTTLS relay and preserve the original templates, sender and attachments.

Follow [integration setup](integrations.md) for calendar, conferencing, payment, CRM and automation credentials.
Provider OAuth client secrets are installation configuration. Per-user account tokens remain server-side application records in D1.
Install app-store metadata and connect the user or team account before expecting an enabled integration to appear on event types.

## Deploy and verify

1. Complete the [Bun/vinext milestone](porting/plan.md#phase-1-establish-the-original-application-on-vinext) and use its frozen Bun lockfile.
2. Build the web, API v2 and docs workspaces. Validate configuration and generated binding types against their intended environment.
3. Apply the reviewed D1 migrations. Back up existing data before a production schema change and retain an appropriate recovery procedure.
4. Deploy API v2, job/queue/state handlers and their bindings, then the web Worker and its `API_V2` service binding.
5. Publish the docs build and Static Assets separately.
6. Configure custom domains and provider callbacks for the actual public URLs.
7. Verify authentication, booking, reschedule/cancel, provider events, delivered email, signed webhooks, retries and cached/uncached access.

Do not treat resource creation or a successful build as provider-delivery evidence.
The [release milestone](porting/plan.md#phase-5-complete-authorized-release-acceptance) defines final workload and recovery checks.
