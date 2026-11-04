# Cal.flare

Cal.flare ports Cal.diy's scheduling platform to Cloudflare Workers and D1, preserving its UI, routes, copy and integrations.
The application uses vinext and React 19, with Bun for package management and workspace commands.

The Cloudflare port is in progress. The guides below describe the target setup; the [port plan](docs/porting/plan.md) tracks when each part becomes runnable.

## Features

- Public booking pages, availability, time zones, recurring events, seats, confirmation, rescheduling and cancellation.
- Individual and team scheduling, event types, onboarding, account settings and permissions.
- Calendar sync, conferencing, payment and CRM integrations.
- Email, reminders, signed webhooks, background jobs, API v2 and embeds.
- Original translations, themes, responsive layouts and documentation.

Behavior follows the [Cal.diy baseline](https://github.com/calcom/cal.diy/commit/e8afecd163cd3a0a3ff279bd4721aa7f073c4685).
The [behavior contract](docs/porting/behavior.md) includes configuration-dependent features, community-edition stubs and failure paths.

## Stack

| Component | Choice |
| --- | --- |
| Package manager | Bun 1.4.4, workspaces and committed `bun.lock`. |
| Web framework | vinext 1.4.2 with Vite 8 and React 19.3.1. |
| Application hosting | Cloudflare Workers for web and API v2. |
| Database | Cloudflare D1 with Prisma and guarded atomic batches. |
| Authentication | Self-hosted Better Auth on Workers and D1, preserving Cal's identity and permission rules. |
| Translations | i18next and react-i18next with original locale JSON and keys. |
| Background work | D1 task state, Cloudflare Queues, Cron Triggers and Durable Objects. |
| Assets and cache | Workers Static Assets and the selected Cloudflare response cache. |

See [architecture](docs/porting/architecture.md) for exact dependency pins, bindings and compatibility contracts.
Node is used only where build tools require it. Application hosting does not require a Node server or external PostgreSQL database.

## Getting started

1. Install [Bun 1.4.4](https://bun.com/docs/installation) and the architecture's Node build-tool version.
2. Clone the repository and read the [Cloudflare setup guide](docs/cloudflare.md).
3. Choose your public web URL and prepare the application secrets, mail relay and provider credentials.
4. Configure the integrations you need using the [integration guide](docs/integrations.md).
5. Follow the [Bun and vinext milestone](docs/porting/plan.md#phase-1-establish-the-original-application-on-vinext) before running the target application commands.

```sh
git clone git@github.com:ralphbibera/cal.flare.git
cd cal.flare
bun --version
```

The source still contains upstream Yarn scripts while the toolchain migration is pending. Do not use its PostgreSQL/Docker setup as the Cloudflare deployment procedure.

## Cloudflare setup

The web and API v2 Workers share one D1 database. The docs site has separate static assets and no application database access.
Source configuration belongs in each app's `cloudflare.config.ts` and `vite.config.ts`.

| Resource | Purpose |
| --- | --- |
| `DB` | D1 application records, auth tables, tasks and migration history. |
| `ASSETS` | Public files, fonts, embed scripts and built assets. |
| `API_V2` | Web-to-v2 service binding that preserves `/api/v2`. |
| `JOBS` | Background job delivery. |
| `RUNTIME_STATE` | Durable Object cache and rate-limit state. |
| Response Store bindings | Selected cache metadata and disposable response bodies. |

The [Cloudflare guide](docs/cloudflare.md) covers bindings, local D1, migrations, secrets, custom domains, mail and deployment order.
All application records move to D1, including IDs, relationships, JSON/list fields, defaults and atomic writes.

### URLs and secrets

Set `NEXT_PUBLIC_WEBAPP_URL`, `NEXT_PUBLIC_WEBSITE_URL`, `NEXT_PUBLIC_EMBED_LIB_URL` and `NEXTAUTH_URL` for your deployment.
Provider callbacks must use that same public origin.
Store `NEXTAUTH_SECRET`, `CALENDSO_ENCRYPTION_KEY`, mail credentials and provider client secrets as Worker secrets.
Use ignored `.dev.vars` files for local development. Configure each secret on every Worker that consumes it.

Only the explicit public build allowlist belongs in browser bundles. Provider credentials, signing keys and account tokens remain server-side.
See [environment references](docs/porting/inventory/environment.tsv) and [integration configuration](.env.appStore.example) for retained names.

### Email

Configure `EMAIL_FROM` and either `RESEND_API_KEY`, `EMAIL_SERVER`, or the `EMAIL_SERVER_HOST`, `EMAIL_SERVER_PORT`, `EMAIL_SERVER_USER` and `EMAIL_SERVER_PASSWORD` fields.
Use a supported public TLS/STARTTLS relay. Local sendmail is not available on Workers.
Keep the original sender, templates, attachments, locale and email-suppression settings.
Verify confirmation, cancellation, reminder and password-recovery messages with your test recipient before production use.

## Integrations

Start with the provider guides below. [All integrations](docs/integrations.md#complete-integration-catalog) are indexed with their configuration and existing setup documentation.
Provider registration and credentials remain necessary even when the application runs entirely on Cloudflare.

| Integration | Setup |
| --- | --- |
| Google Calendar and Meet | [Enable Calendar API, configure OAuth and download client JSON](docs/integrations.md#google-calendar-and-meet). |
| Google login | [Register the login callback and enable the login flag](docs/integrations.md#google-calendar-and-meet). |
| Microsoft 365 and Teams | [Register a Microsoft Entra application](docs/integrations.md#microsoft-365-and-teams). |
| Zoom | [Configure OAuth and meeting scopes](docs/integrations.md#zoom). |
| Cal Video / Daily | [Configure the Daily API key](docs/integrations.md#cal-video-and-daily). |
| Basecamp | [Configure OAuth credentials and User-Agent](docs/integrations.md#basecamp). |
| HubSpot | [Configure its OAuth app and CRM permissions](docs/integrations.md#hubspot). |
| Webex | [Existing setup guide](packages/app-store/webex/README.md). |
| Zoho CRM, Calendar and Bigin | [Zoho configuration](docs/integrations.md#zoho). |
| Pipedrive | [Existing Pipedrive/Revert setup](packages/app-store/pipedrive-crm/README.md). |
| Stripe and other payment apps | [Payment configuration and baseline limitations](docs/integrations.md#payments). |
| Zapier and Make | [Automation setup](docs/integrations.md#automation-and-webhooks). |
| Other calendar, video, CRM and catalog apps | [Complete integration catalog](docs/integrations.md#complete-integration-catalog). |

After configuring an app, enable it in the app store, connect the intended user or team account, and select its calendars or event-type settings.
Credential registration alone does not verify callbacks, refresh, delivery or every feature exposed by that provider.

## Develop with Bun

Bun replaces Yarn for installs, dependency changes, workspace commands and CI.
The toolchain milestone converts the workspace scripts, verifies retained dependency resolutions, commits `bun.lock`, and removes the unused Yarn configuration.
Existing Vitest and Playwright suites remain in place; changing package managers does not replace their assertions or test runner.

The target command interface is:

```sh
bun install --frozen-lockfile
bun run --cwd apps/web dev
bun run lint
bun run type-check:ci
bun run test
bun run --cwd apps/web build
```

Use these application commands after the [toolchain milestone](docs/porting/plan.md#phase-1-establish-the-original-application-on-vinext) provides the Bun lockfile and converted scripts.
The [Bun migration contract](docs/porting/architecture.md#bun-workspaces-and-lockfile) covers workspace resolution, lifecycle scripts and frozen CI installs.

## Deploy

Build and validate the web, v2 and docs applications with their Bun workspace scripts.
Apply D1 migrations before releasing code that consumes the new schema.
Deploy v2 and its job/state bindings before the web Worker that uses `API_V2`; publish the docs assets independently.
Configure public domains and exact provider callback URLs, then verify login, booking, calendar delivery, email and webhook behavior.

Use the native vinext Cloudflare deployment configuration. The [deployment guide](docs/cloudflare.md#deploy-and-verify) describes the release checks and resource ordering.

## Contribute

Read [AGENTS.md](AGENTS.md), the [port plan](docs/porting/plan.md) and [execution rules](docs/porting/execution.md).
Original application and package folders remain in place. Use the [source inventory](docs/porting/inventory/README.md) and [behavior contracts](docs/porting/behavior.md) when migrating a flow.
Compare observable UI, HTTP results, persisted state and provider effects, including denial, retry and partial-failure paths.

## License and lineage

Cal.flare is based on [Cal.diy](https://github.com/calcom/cal.diy) and Cal.com.
The upstream [MIT license](LICENSE), copyright notices and source attribution remain intact.
