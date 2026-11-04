# Cal.flare

<p align="center">
  <a href="https://github.com/ralphbibera/cal.flare">
    <img src="https://user-images.githubusercontent.com/8019099/210054112-5955e812-a76e-4160-9ddd-58f2c72f1cce.png" alt="Cal.diy project logo">
  </a>
</p>

<p align="center">
  The community-driven, open-source scheduling platform on Cloudflare.
  <br>
  <a href="https://github.com/ralphbibera/cal.flare"><strong>GitHub</strong></a>
  &middot; <a href="https://github.com/ralphbibera/cal.flare/issues">Issues</a>
  &middot; <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-purple" alt="MIT license"></a>
  <a href="https://github.com/ralphbibera/cal.flare/stargazers"><img src="https://img.shields.io/github/stars/ralphbibera/cal.flare" alt="GitHub stars"></a>
  <a href="https://github.com/ralphbibera/cal.flare/pulse"><img src="https://img.shields.io/github/commit-activity/m/ralphbibera/cal.flare" alt="Commit activity"></a>
  <a href="CODE_OF_CONDUCT.md"><img src="https://img.shields.io/badge/Contributor%20Covenant-1.4-purple" alt="Code of conduct"></a>
</p>

> [!WARNING]
> Cal.flare is a community-maintained Cal.diy port intended for personal, non-production use while the Cloudflare migration remains unverified.
> Self-hosting requires knowledge of Cloudflare account administration, database migrations, credential security and backups. Review the setup and configuration carefully.
> The setup below describes the target workflow as its [implementation milestones](docs/porting/plan.md) become available.

## About Cal.flare

<img width="100%" alt="Cal.diy booking interface" src="https://github.com/calcom/cal.diy/assets/8019099/407e727e-ff19-4ca4-bcae-049dca05cf02">

Cal.flare brings [Cal.diy](https://github.com/calcom/cal.diy)'s community scheduling application to Cloudflare Workers and D1.
The port preserves its routes, components, markup, copy, translations, permissions and integration behavior.
The [source baseline](https://github.com/calcom/cal.diy/commit/e8afecd163cd3a0a3ff279bd4721aa7f073c4685) defines the feature scope, including community-edition limitations and stubs.

### What's different from Cal.com?

- Cal.diy's community edition is the product baseline; the port does not add enterprise-only behavior.
- No Cal.com account or commercial license key is required for that community application.
- The project retains the upstream MIT license and source attribution.
- The deployment target is Cloudflare, with D1 for application records and Bun for package management.
- You operate your own installation. Cloudflare hosting does not remove calendar, conferencing, mail or payment providers' account requirements.

### Built with

- [vinext](https://vinext.dev/) for Next-compatible App Router, Pages Router, layouts and Server Actions.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [D1](https://developers.cloudflare.com/d1/).
- [Bun](https://bun.com/) 1.4.4 for package management and workspace commands.
- [React](https://react.dev/) 19, [tRPC](https://trpc.io/), [Tailwind CSS](https://tailwindcss.com/) and [Prisma](https://prisma.io/).
- Self-hosted [Better Auth](https://better-auth.com/) on Workers and D1, preserving Cal's identity policy.
- [i18next](https://www.i18next.com/) and react-i18next with original resources and keys.
- [Daily](https://daily.co/) and the original provider adapters for supported conferencing features.

Exact versions and runtime responsibilities are in [architecture](docs/porting/architecture.md).
Original application and package folders remain in place; use the [source inventory](docs/porting/inventory/README.md) when migrating a flow.

## Getting started

Use the [Cloudflare setup guide](docs/cloudflare.md) alongside the steps below.
The target uses Workers for application hosting and D1 for all relational application data.
The inherited Yarn/Next/PostgreSQL scripts require the planned toolchain and database conversion before these target commands are usable.

### Prerequisites

- Bun 1.4.4 and Git.
- Node 24.22.0 for build tools whose engine requirements need it. It is not the application host.
- A Cloudflare account with the Workers, D1 and other selected resource capabilities required by the deployment.
- Provider registrations and credentials for the [integrations](#integrations) you enable.
- OpenSSL or an equivalent secure generator for installation secrets.

## Development

### Setup

1. Clone the repository and enter its directory:

   ```sh
   git clone git@github.com:ralphbibera/cal.flare.git
   cd cal.flare
   ```

   On Windows, use Git Bash or WSL with symlink support. If needed, clone with `git clone -c core.symlinks=true git@github.com:ralphbibera/cal.flare.git`.

2. Select Bun 1.4.4 and the required Node build-tool version. Verify Bun with `bun --version`.
3. Install the accepted workspace graph from its committed Bun lockfile:

   ```sh
   bun install --frozen-lockfile
   ```

4. Configure the public URLs and local secrets in ignored `.dev.vars` files for each consuming Worker. Retain the original variable names from the [environment inventory](docs/porting/inventory/environment.tsv).
5. Generate distinct installation secrets:

   ```sh
   openssl rand -base64 32
   openssl rand -base64 24
   ```

   Use the first value for `NEXTAUTH_SECRET` and the second 32-character value for `CALENDSO_ENCRYPTION_KEY`.
   Generate a fresh `CRON_API_KEY` as well. Keep encryption keys stable for an existing installation.
6. Bind the same local D1 database as `DB` for web and API v2. Configure `API_V2`, `JOBS`, `RUNTIME_STATE`, assets and cache bindings according to the [Cloudflare guide](docs/cloudflare.md#bind-resources).
7. Apply the converted D1 migrations and run the ported synthetic seed or setup flow before using data-dependent routes.
8. Start the web workspace through Bun:

   ```sh
   bun run --cwd apps/web dev
   ```

Use the local origin printed by the development server and keep `NEXTAUTH_URL`, application URLs and callback registrations consistent with it.
The [Bun migration contract](docs/porting/architecture.md#bun-workspaces-and-lockfile) replaces Yarn installs, workspace wrappers, script calls and CI commands while retaining original package names and tests.

#### Quick start with local D1

Local development uses workerd and isolated D1 state. It does not need the upstream Postgres Docker stack.
After the Bun and D1 milestones provide the runners, install dependencies, apply `packages/prisma/migrations-d1/`, seed synthetic data and start the web/API Workers.
See [local D1 setup](docs/cloudflare.md#prepare-d1) for shared database identity and migration ordering.

The upstream development seed defines these test accounts:

| Email | Password | Role |
| --- | --- | --- |
| `free@example.com` | `free` | Free user |
| `pro@example.com` | `pro` | Pro user |
| `trial@example.com` | `trial` | Trial user |
| `admin@example.com` | `ADMINadmin2022!` | Admin user |
| `onboarding@example.com` | `onboarding` | Onboarding incomplete |

They exist only when the corresponding synthetic seed has run. The D1 seed must preserve the inherited fixtures used by tests.
Keep fixture accounts in isolated development/test databases, rather than adding them to a real installation.
Inspect local records with the D1 development tools; the PostgreSQL Prisma Studio setup is not the D1 procedure.

#### Development tips

`NEXT_PUBLIC_LOGGER_LEVEL` controls the original tRPC/application logging threshold:

| Level | Name |
| --- | --- |
| `0` | silly |
| `1` | trace |
| `2` | debug |
| `3` | info |
| `4` | warn |
| `5` | error |
| `6` | fatal |

A value includes that level and higher. For example, `3` includes info, warn, error and fatal. The source defaults to `4` when unset.
Expose this public setting through the explicit browser build allowlist where consumed; keep private log payloads and credentials redacted.

If a Node-based build tool runs out of heap, adjust `NODE_OPTIONS=--max-old-space-size=<MiB>` to fit the build machine.
That setting does not increase Cloudflare Worker limits.

#### Gitpod and cloud workspaces

A cloud development workspace needs the same Bun and Node build-tool versions, Worker tooling and isolated D1 configuration as a local checkout.
Forward the development port and set application/auth URLs to that reachable origin when testing callbacks.
The inherited Gitpod Docker/PostgreSQL tasks need conversion before they represent this setup; they are not a ready-made Cloudflare environment.

#### Manual setup

1. Configure Worker bindings and consumed variables. Use the [runtime/build configuration](#configuration) tables below.
2. Generate the domain client from the converted schema through the Bun workspace command supplied by the toolchain milestone.
3. Apply the ordered SQLite migrations in `packages/prisma/migrations-d1/` through the D1 migration runner, using fresh local state for development.
4. Populate the required app-store metadata and synthetic fixtures. The seed's Prisma calls must target D1, including relation and default behavior.
5. Configure a development mail receiver when the retained email tests require one.
6. Start the web and API v2 Workers with the same local D1 identity and the required service bindings.

Do not substitute `DATABASE_URL=postgresql://...` or `prisma migrate deploy` for the D1 binding/migration workflow.

For inherited tests that use MailHog, retain the receiver fixture:

```sh
docker pull mailhog/mailhog
docker run -d -p 8025:8025 -p 1025:1025 mailhog/mailhog
```

This is a local test receiver, not the production mail transport. Connect it through the accepted workerd test setup when `E2E_TEST_MAILHOG_ENABLED=1`.
A deployed Worker uses the supported public TLS/STARTTLS relay described under [email configuration](docs/cloudflare.md#configure-mail-and-integrations).

#### Setting up your first user

##### Approach 1. Application setup

Open the local or deployed application after its schema and identity configuration are ready.
Use the setup/signup flow to create the initial user, so the original password hashing, profile defaults, verification and admin policy execute.
Do not bypass those services by inserting a user/password row manually.

##### Approach 2. Development seed

Run the ported synthetic seed against fresh local D1, then sign in with the fixture account that matches the scenario you need.
The inherited [seed](scripts/seed.ts) and [tests](docs/porting/behavior.md) define expected fixture behavior.
Do not run the development seed as a production upgrade step.

### E2E testing

Set `NEXTAUTH_URL` and the test base URL to the actual Worker origin. The test runner must target vinext/workerd and D1 before a pass counts as port evidence.
Retain the existing Playwright test ownership and assertions; Bun runs the package scripts.

The target commands are:

```sh
bun run test-e2e
bunx playwright show-report test-results/reports/playwright-html-report
```

#### Resolving issues

##### E2E test browsers not installed

Install the browsers using the workspace's pinned Playwright version:

```sh
bunx playwright install
```

An error such as `Executable doesn't exist ... chromium ...` usually indicates a missing browser installation or a cache/version mismatch.
Keep the browser executable aligned with the Playwright version in the accepted lockfile.

### Upgrading from earlier versions

1. Review the release's schema, binding, public-variable and provider changes, then update the checkout:

   ```sh
   git pull --ff-only
   bun install --frozen-lockfile
   ```

2. Back up the target database and establish its recovery procedure before a production schema change.
3. Apply the reviewed D1 migrations in order before releasing code that consumes the new schema. Do not run a development reset or seed on live data.
4. Update required Worker bindings/secrets and rebuild client assets when public build-time values change.
5. Build the affected workspaces and deploy the dependent services in the order described below.
6. Verify sessions, booking, reschedule/cancel, provider events, email and retries against the new release.

Keep `NEXTAUTH_SECRET` and `CALENDSO_ENCRYPTION_KEY` stable unless a deliberate key-rotation procedure is part of the release.

## Deployment

### Cloudflare Workers

The web and API v2 Workers share one authoritative D1 database. Docs has its own assets and no product DB binding.
Cloudflare Queues, Cron Triggers and Durable Objects replace the selected incompatible job/state hosting boundaries.

1. Configure each app's source `vite.config.ts` and `cloudflare.config.ts` using the [bound architecture](docs/porting/architecture.md).
2. Bind `DB`, assets, the `API_V2` service and the selected queue/state/cache resources. Use separate data and resources for development and production.
3. Set deployment secrets using [Worker secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/), not committed environment files.
4. Build through the accepted Bun workspace scripts and apply the reviewed D1 migrations.
5. Deploy v2 and its job/state handlers before the web Worker that consumes `API_V2`. Publish docs assets separately.
6. Configure domains and exact OAuth callback URLs, then verify the complete booking and delivery flows.

The [Cloudflare setup guide](docs/cloudflare.md) expands these steps. Native vinext Cloudflare build output is generated; configuration files remain source-controlled.
Railway, Northflank, Vercel, Render and Docker-hosted Node/PostgreSQL deployments are not Cal.flare targets.

### Configuration

#### Important runtime variables and bindings

| Name | Purpose |
| --- | --- |
| `DB` | D1 application/auth records, tasks and migration history; shared by web and v2. |
| `ASSETS` | The app's public files, fonts, embed output and built assets. |
| `API_V2` | Web-to-v2 service binding that preserves public `/api/v2`. |
| `JOBS`, `RUNTIME_STATE` | Selected queue transport and Durable Object job/cache/limiter state. |
| Response Store bindings | Native helper-owned cache metadata and disposable response bodies. |
| `NEXTAUTH_URL` | Public auth origin, consistent with the web deployment and its callback URLs. |
| `NEXTAUTH_SECRET` | Installation signing/session secret. Generate your own secure value. |
| `CALENDSO_ENCRYPTION_KEY` | Stable 32-character encryption key for stored Cal credentials/data. |
| `CRON_API_KEY` | Authentication for retained cron HTTP endpoints. |
| `EMAIL_FROM` | Original sender identity; configure the selected relay's credentials as well. |

Mail selection retains `RESEND_API_KEY`, `EMAIL_SERVER`, or explicit `EMAIL_SERVER_HOST`, `EMAIL_SERVER_PORT`, `EMAIL_SERVER_USER` and `EMAIL_SERVER_PASSWORD` configuration.
Use a supported public TLS/STARTTLS relay. Workers has no local sendmail executable.
See [environment references](docs/porting/inventory/environment.tsv), [.env.example](.env.example) and [.env.appStore.example](.env.appStore.example) for retained names.
The example files describe upstream inputs; their PostgreSQL URLs and container assumptions do not configure D1.

#### Build-time variables

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_WEBAPP_URL` | Public application origin used in client output. |
| `NEXT_PUBLIC_WEBSITE_URL` | Website origin where consumed by the application. |
| `NEXT_PUBLIC_EMBED_LIB_URL` | Public embed script URL. |
| `NEXT_PUBLIC_WEBSITE_TERMS_URL` | Optional terms URL. |
| `NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL` | Optional privacy-policy URL. |
| `CALCOM_TELEMETRY_DISABLED` | Retained telemetry opt-out configuration; `1` disables it where consumed. |

Only explicitly allowlisted public values enter browser bundles. Auth, encryption, provider and signing secrets remain server-side.
Generate binding types before standalone type checks. Rebuild public assets when a build-time URL or flag changes.

### Troubleshooting

#### TLS and public URLs

Use valid HTTPS for production domains and provider callbacks, with the same public origin in application/auth configuration.
Keep TLS verification enabled. Fix certificates, trust or the configured URL instead of setting `NODE_TLS_REJECT_UNAUTHORIZED=0`.
Cloudflare handles edge TLS; the Docker container loopback workaround is not the Worker routing model.

#### Failed user creation or relation writes

Use the actual D1/Prisma error and original input contract to identify the failed field, constraint or relation.
Keep generated integer IDs, JSON/null representation and nested-write atomicity source-compatible.
Run signup/setup through its production service rather than editing rows to bypass missing defaults or password hashing.
See the [D1 representation and atomicity contract](docs/porting/architecture.md#full-d1-schema-and-atomicity).

#### Session fetch errors

Check `NEXTAUTH_URL`, application origins, cookie domain/secure settings, installation secrets and callback paths first.
Inspect the actual Worker auth response and its repeated `Set-Cookie` headers, then compare server and browser session projections.
Keep response cookies when crossing server boundaries and preserve the original public error mapping.
Do not replace the public origin with a Docker service name or disable TLS checks to hide a failed session request.

## License

Cal.flare retains the upstream [MIT license](LICENSE), copyright notices and source attribution.
The community application does not require a Cal.com commercial license key. Third-party integrations retain their own account and permission requirements.

## Enabling Content Security Policy

Set `CSP_POLICY="non-strict"` where the original policy is consumed.
The baseline enables strict policy on login, report-only behavior on other supported SSR pages, and does not claim the same SSG coverage.
Preserve nonce generation, embed/CSP headers and the source exception for inline styles.
Check custom components for compatibility and inspect violation reports before changing policy.

## Integrations

Provider credentials and consent are still required on Cloudflare. Use your public web origin for callback URLs.
Store deployment secrets in Worker secret bindings and local values in ignored `.dev.vars` files. Apply a secret to each Worker that consumes it.
Some apps use **Settings → Admin → Apps** key fields instead of environment variables; keep that adapter's key schema.
The [integration guide](docs/integrations.md) and [complete catalog](docs/integrations.md#complete-integration-catalog) cover every app-store definition and existing per-app setup guide.

### Obtaining the Google API Credentials

1. Open [Google API Console](https://console.cloud.google.com/apis/dashboard). If you don't have a project in your Google Cloud subscription, you'll need to create one before proceeding further. Under Dashboard pane, select Enable APIS and Services.
2. In the search box, type calendar and select the Google Calendar API search result.
3. Enable the selected API.
4. Next, go to the [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) from the side pane. Select the app type (Internal or External) and enter the basic app details on the first page.
5. Add the Calendar scopes requested by the adapter: `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.readonly`. Keep the profile/email scopes required by the enabled login flow.
6. In the third page (Test Users), add the Google account(s) you'll be using. Make sure the details are correct on the last page of the wizard and your consent screen will be configured.
7. Now select [Credentials](https://console.cloud.google.com/apis/credentials) from the side pane and then select Create Credentials. Select the OAuth Client ID option.
8. Select Web Application as the Application Type.
9. Register `<Cal.flare URL>/api/integrations/googlecalendar/callback`. For Google login, also register `<Cal.flare URL>/api/auth/callback/google`, using your actual public origin.
10. The key will be created and you will be redirected back to the Credentials page. Select the newly generated client ID under OAuth 2.0 Client IDs.
11. Select Download JSON. Copy the contents of this file and paste the entire JSON string as the `GOOGLE_API_CREDENTIALS` Worker secret.

#### Add Google Calendar to the app store

After the D1 app-store seed is ported, populate app metadata using the Bun workspace command:

```sh
bun run --cwd packages/prisma seed-app-store
```

Enable the Google Calendar app, connect the intended account and choose its destination/conflict calendars.
Set `GOOGLE_LOGIN_ENABLED=true` when enabling Google login, and register its callback as described above.
Publish or verify the OAuth consent application when required for the users and scopes you intend to support; test-user access follows Google's consent configuration.

### Obtaining Microsoft Graph Client ID and Secret

1. Open [Azure App Registration](https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredApps) and select New registration
2. Name your application
3. Set **Who can use this application or access this API?** to **Accounts in any organizational directory (Any Azure AD directory - Multitenant)**
4. Set the **Web** redirect URI to `<Cal.flare URL>/api/integrations/office365calendar/callback` replacing Cal.flare URL with the URI at which your application runs.
5. Use **Application (client) ID** as the **MS_GRAPH_CLIENT_ID** server configuration value
6. Create a client secret under **Certificates & secrets** and store its value as **MS_GRAPH_CLIENT_SECRET**.
7. Grant the delegated scopes requested by the adapter: `User.Read`, `Calendars.Read`, `Calendars.ReadWrite` and `offline_access`, with consent appropriate to your tenant.
8. Connect the account and select its calendars. Teams conferencing requires an eligible work or school account.

### Obtaining Zoom Client ID and Secret

1. Open [Zoom Marketplace](https://marketplace.zoom.us/) and sign in with your Zoom account.
2. On the upper right, click "Develop" => "Build App".
3. Select "General App" , click "Create".
4. Name your App.
5. Choose "User-managed app" for "Select how the app is managed".
6. De-select the option to publish the app on the Zoom App Marketplace, if asked.
7. Now copy the Client ID and Client Secret to server-side configuration under the `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` fields.
8. Set the "OAuth Redirect URL" under "OAuth Information" as `<Cal.flare URL>/api/integrations/zoomvideo/callback` replacing Cal.flare URL with the URI at which your application runs.
9. Also add the redirect URL given above as an allow list URL and enable "Subdomain check". Make sure, it says "saved" below the form.
10. You don't need to provide basic information about your app. Instead click on "Scopes" and then on "+ Add Scopes". On the left,
    1. click the category "Meeting" and check the scope `meeting:write:meeting`.
    2. click the category "User" and check the scope `user:read:settings`.
11. Click "Done".
12. Enable Zoom in Cal.flare, connect the account, and verify the meeting operations used by your event types.

### Obtaining Daily API Credentials

1. Open [Daily.co](https://daily.co/) and create an account.
2. From within your dashboard, go to the [developers](https://dashboard.daily.co/developers) tab.
3. Copy your API key.
4. Store the API key as the `DAILY_API_KEY` Worker secret.
5. Set `DAILY_SCALE_PLAN` only when your Daily account supports the features it enables, such as recording.

### Obtaining Basecamp Client ID and Secret

1. Visit the [37signals integrations dashboard](https://launchpad.37signals.com/integrations) and sign in.
2. Register a new application by clicking the Register one now link.
3. Fill in your company details.
4. Select Basecamp 4 as the product to integrate with.
5. Set the Redirect URL for OAuth `<Cal.flare URL>/api/integrations/basecamp3/callback` replacing Cal.flare URL with the URI at which your application runs.
6. Click on done and copy the Client ID and secret into the `BASECAMP3_CLIENT_ID` and `BASECAMP3_CLIENT_SECRET` fields.
7. Set `BASECAMP3_USER_AGENT` to identify your application and support contact. Keep the OAuth client secret in `BASECAMP3_CLIENT_SECRET`.

### Obtaining HubSpot Client ID and Secret

1. Open [HubSpot Developer](https://developer.hubspot.com/) and sign into your account, or create a new one.
2. From within the home of the Developer account page, go to "Manage apps".
3. Create a public OAuth application using the app-registration flow available to your developer account.
4. Fill in any information you want in the "App info" tab
5. Go to tab "Auth"
6. Now copy the Client ID and Client Secret to server-side configuration under the `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` fields.
7. Set the Redirect URL for OAuth `<Cal.flare URL>/api/integrations/hubspot/callback` replacing Cal.flare URL with the URI at which your application runs.
8. Grant the adapter's scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write` and `crm.objects.owners.read`.
9. Click the "Save" button at the bottom footer.
10. Connect the HubSpot account, then verify the expected contact and meeting effects with a synthetic booking.

### Obtaining Webex Client ID and Secret

[See Webex Readme](./packages/app-store/webex/)

### Obtaining ZohoCRM Client ID and Secret

1. Open [Zoho API Console](https://api-console.zoho.com/) and sign into your account, or create a new one.
2. From within the API console page, go to "Applications".
3. Click "ADD CLIENT" button top right and select "Server-based Applications".
4. Fill in any information you want in the "Client Details" tab
5. Go to tab "Client Secret" tab.
6. Now copy the Client ID and Client Secret to server-side configuration under the `ZOHOCRM_CLIENT_ID` and `ZOHOCRM_CLIENT_SECRET` fields.
7. Set the Redirect URL for OAuth `<Cal.flare URL>/api/integrations/zohocrm/callback` replacing Cal.flare URL with the URI at which your application runs.
8. In the "Settings" section check the "Multi-DC" option if you wish to use the same OAuth credentials for all data centers.
9. Click the "Save"/ "UPDATE" button at the bottom footer.
10. Enable the Zoho CRM app, connect the account and verify its intended booking effects.

### Obtaining Zoho Calendar Client ID and Secret

[Follow these steps](./packages/app-store/zohocalendar/)

### Obtaining Zoho Bigin Client ID and Secret

[Follow these steps](./packages/app-store/zoho-bigin/)

### Obtaining Pipedrive Client ID and Secret

[Follow these steps](./packages/app-store/pipedrive-crm/)

### Rate limiting

The Cloudflare target uses the `RUNTIME_STATE` Durable Object for limiter storage.
Preserve the original namespaces, windows, response shape, fail-open behavior and enabled/disabled configuration.
An installation with the legacy `UNKEY_ROOT_KEY` unset must not gain rate limiting merely because the DO exists.
Follow the [state and job contract](docs/porting/architecture.md#jobs-ephemeral-state-and-integrations) when migrating the configuration; an external Unkey service is not required by the selected target.

### Payments and automation

- [Stripe setup](packages/app-store/stripepayment/README.md) covers Connect OAuth and payment credentials.
- [HitPay](packages/app-store/hitpay/README.md), [PayPal](packages/app-store/paypal), [BTCPay](packages/app-store/btcpayserver) and [Alby](packages/app-store/alby) retain their own provider settings and signature rules.
- [Zapier](packages/app-store/zapier/README.md) and [Make](packages/app-store/make/README.md) describe API-key connections and webhook setup.

The community baseline contains Stripe webhook stubs. Registering credentials does not replace those stubs with payment fulfillment.
Check the [payment behavior contract](docs/porting/behavior.md#d_payments) for the specific flow and limitations.

## Contributing

Contributions are welcome, including documentation, translations, source-compatible fixes and complete migration slices.
Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for domain/code conventions, using this README's Bun and Cloudflare workflow for target tooling.
Use the [port plan](docs/porting/plan.md), [architecture](docs/porting/architecture.md) and [behavior contracts](docs/porting/behavior.md) to preserve scope and identify real prerequisites.
Keep changes focused, follow Conventional Commits and verify affected source/callers. Product behavior changes need a separate decision from the port.
Contributions here do not automatically change upstream Cal.diy or Cal.com's hosted platform.

### Good first issues

Look for [help-wanted issues](https://github.com/ralphbibera/cal.flare/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) with a bounded source-compatible result.
Documentation corrections, retained-test runner wiring and isolated migration prerequisites can be useful starting points.
Do not create work or fragment one flow merely to fill parallel slots.

### Contributors

[Cal.flare contributors](https://github.com/ralphbibera/cal.flare/graphs/contributors) build on the work of the [Cal.diy community](https://github.com/calcom/cal.diy/graphs/contributors) and Cal.com.

<a href="https://github.com/calcom/cal.diy/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=calcom/cal.diy" alt="Upstream Cal.diy contributors">
</a>

### Translations

You can contribute translations without changing application logic.
Keep original keys and namespaces in `packages/i18n/locales`; English base strings are in `packages/i18n/locales/en/common.json`.
Preserve interpolation, fallback and pluralization behavior, and verify the affected locale in SSR, hydration and RTL layouts where applicable.
Do not restore keys deliberately removed from the selected upstream baseline.

## Acknowledgements

Cal.flare builds on [Cal.diy](https://github.com/calcom/cal.diy), [Cal.com](https://cal.com) and their contributors.
The original project and port depend on work from:

- [Cloudflare](https://www.cloudflare.com/) and [vinext](https://vinext.dev/).
- [Bun](https://bun.com/).
- [Vercel](https://vercel.com/) and [Next.js](https://nextjs.org/).
- [Day.js](https://day.js.org/).
- [Tailwind CSS](https://tailwindcss.com/).
- [Prisma](https://prisma.io/).
