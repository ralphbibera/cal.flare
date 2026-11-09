> [!WARNING]
> Use at your own risk. Cal.flare is the open source community edition of Cal.com and it is intended for users who want to self-host their own Cal.flare instance. It is strictly recommended for personal, non-production use. Please review all installation and configuration steps carefully. Self-hosting requires advanced knowledge of Cloudflare administration, D1 database management, and securing sensitive data. Proceed only if you are comfortable with these responsibilities.

> [!TIP]
> For any commercial and enterprise-ready scheduling infrastructure, use Cal.com, not Cal.flare; hosted by us or get invited to on-prem enterprise access here: <a href="https://cal.com/sales">https://cal.com/sales</a>

<!-- PROJECT LOGO -->
<p align="center">
  <a href="https://github.com/ralphbibera/cal.flare">
   <img src="https://user-images.githubusercontent.com/8019099/210054112-5955e812-a76e-4160-9ddd-58f2c72f1cce.png" alt="Logo">
  </a>

  <h1 align="center">Cal.flare</h1>

  <p align="center">
    The community-driven, open-source scheduling platform.
    <br />
    <a href="https://github.com/ralphbibera/cal.flare"><strong>GitHub</strong></a>
    <br />
    <a href="https://github.com/ralphbibera/cal.flare/issues">Issues</a>
    &middot;
    <a href="./CONTRIBUTING.md">Contributing</a>
  </p>
</p>

<p align="center">
   <a href="https://github.com/ralphbibera/cal.flare/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-purple" alt="License"></a>
   <a href="https://github.com/ralphbibera/cal.flare/stargazers"><img src="https://img.shields.io/github/stars/ralphbibera/cal.flare" alt="Github Stars"></a>
   <a href="https://github.com/ralphbibera/cal.flare/pulse"><img src="https://img.shields.io/github/commit-activity/m/ralphbibera/cal.flare" alt="Commits-per-month"></a>
   <a href="https://github.com/ralphbibera/cal.flare/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22"><img src="https://img.shields.io/badge/Help%20Wanted-Contribute-blue"></a>
   <a href="https://contributor-covenant.org/version/1/4/code-of-conduct/"><img src="https://img.shields.io/badge/Contributor%20Covenant-1.4-purple" /></a>
</p>

<!-- ABOUT THE PROJECT -->

## About Cal.flare

<img width="100%" alt="booking-screen" src="https://github.com/calcom/cal.diy/assets/8019099/407e727e-ff19-4ca4-bcae-049dca05cf02">

**Cal.flare** ports the community-driven, fully open-source [Cal.diy](https://github.com/calcom/cal.diy) scheduling platform to Cloudflare Workers and D1. Cal.diy is based on [Cal.com](https://cal.com), with its enterprise/commercial code removed.

Cal.flare is **100% MIT-licensed** with no proprietary "Enterprise Edition" features. It's designed for individuals and self-hosters who want full control over their scheduling infrastructure without any commercial dependencies.

### What's different from Cal.com?

- **No enterprise features** — Teams, Organizations, Insights, Workflows, SSO/SAML, and other EE-only features have been removed
- **No license key required** — Everything works out of the box, no Cal.com account or license needed
- **100% open source** — The entire codebase is licensed under MIT, no "Open Core" split
- **Community-maintained** — Contributions are welcome and go directly into this project (see [CONTRIBUTING.md](./CONTRIBUTING.md))

> **Note:** Cal.flare is a self-hosted project. There is no hosted/managed version. You run it on your own infrastructure.

### Built With

- [vinext](https://vinext.dev/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [D1](https://developers.cloudflare.com/d1/)
- [Bun](https://bun.com/)
- [tRPC](https://trpc.io/)
- [React.js](https://reactjs.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Prisma.io](https://prisma.io/)
- [Daily.co](https://daily.co/)

The [port plan](docs/porting/plan.md), [architecture](docs/porting/architecture.md) and [inventory](docs/porting/inventory/README.md) describe the Cloudflare/Bun substitutions.
Prisma remains the normal data-access layer through the official D1 adapter. Existing atomic multi-row operations use native guarded D1 batches; see [D1 and Prisma usage](docs/porting/architecture.md#d1-and-prisma-usage).

<!-- GETTING STARTED -->

## Getting Started

To get a local copy up and running, please follow these simple steps.

### Prerequisites

Here’s what you need to run Cal.flare.

- Bun 1.4.4
- Node.js 24.22.0 for build tools that require it
- A [Cloudflare Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) to deploy Cal.flare
- Local workerd/D1 for development

> If you want to enable any of the available integrations, you may want to obtain additional credentials for each one. More details on this can be found below under the [integrations section](#integrations).

## Development

### Setup

1. Clone the repo (or fork https://github.com/ralphbibera/cal.flare/fork)

   ```sh
   git clone git@github.com:ralphbibera/cal.flare.git
   ```

   > If you are on Windows, run the following command in Git Bash with admin privileges:
   > `git clone -c core.symlinks=true git@github.com:ralphbibera/cal.flare.git`

2. Go to the project folder

   ```sh
   cd cal.flare
   ```

3. Select Bun 1.4.4 and Node 24.22.0 for build tooling. If you use [nvm](https://github.com/nvm-sh/nvm):

   ```sh
   nvm install 24.22.0 && nvm use 24.22.0
   bun --version
   ```

4. Install packages with Bun:

   ```sh
   bun install --frozen-lockfile
   ```

5. Set up local Worker configuration:

   - Set consumed variables in an ignored `.dev.vars` file for the web app. Use [.env.example](.env.example) and [.env.appStore.example](.env.appStore.example) for existing names, with the [Cloudflare binding and secret configuration](docs/cloudflare.md).
   - Generate `NEXTAUTH_SECRET` with `openssl rand -base64 32`.
   - Generate `CALENDSO_ENCRYPTION_KEY` with `openssl rand -base64 24`.
   - Store each value in the consuming Worker's `.dev.vars` file for local development, and in Worker secrets for deployment.

6. Bind the web Worker to the local D1 database and apply the converted migrations. See the [D1 configuration reference](docs/cloudflare.md#prepare-d1).
7. Create your [first user](#setting-up-your-first-user), or load the development fixtures below.
8. Start the application:

   ```sh
   bun run dev
   ```

#### Development test users

**Development seed credentials:**

| Email | Password | Role |
|-------|----------|------|
| `free@example.com` | `free` | Free user |
| `pro@example.com` | `pro` | Pro user |
| `trial@example.com` | `trial` | Trial user |
| `admin@example.com` | `ADMINadmin2022!` | Admin user |
| `onboarding@example.com` | `onboarding` | Onboarding incomplete |

After running the synthetic development seed, you can use these credentials at your local application origin. Keep these fixture accounts out of production data.

> **Tip**: Inspect the seeded records using the local D1 tools. PostgreSQL Prisma Studio is not the D1 inspection path.

#### Development tip

1. Add `export NODE_OPTIONS="--max-old-space-size=16384"` to your shell script to increase the memory limit for a Node build-tool process. This does not change Worker runtime limits. Alternatively, you can run this in your terminal before running the app. Replace 16384 with the amount of RAM you want to allocate to the node process.

2. Add `NEXT_PUBLIC_LOGGER_LEVEL={level}` to local Worker configuration to control the logging verbosity for all tRPC queries and mutations.\
   Where {level} can be one of the following:

   `0` for silly \
   `1` for trace \
   `2` for debug \
   `3` for info \
   `4` for warn \
   `5` for error \
   `6` for fatal

   When you set `NEXT_PUBLIC_LOGGER_LEVEL={level}` in local Worker configuration, it enables logging at that level and higher. Here's how it works:

   The logger will include all logs that are at the specified level or higher. For example: \

   - If you set `NEXT_PUBLIC_LOGGER_LEVEL=2`, it will log from level 2 (debug) upwards, meaning levels 2 (debug), 3 (info), 4 (warn), 5 (error), and 6 (fatal) will be logged. \
   - If you set `NEXT_PUBLIC_LOGGER_LEVEL=3`, it will log from level 3 (info) upwards, meaning levels 3 (info), 4 (warn), 5 (error), and 6 (fatal) will be logged, but level 2 (debug) and level 1 (trace) will be ignored. \

```sh
echo 'NEXT_PUBLIC_LOGGER_LEVEL=3' >> apps/web/.dev.vars
```

for Logger level to be set at info, for example.

#### Gitpod Setup

Use the same Bun, Node build-tool and local workerd/D1 setup in a Gitpod workspace.
Forward the development port and configure application/auth URLs for that origin. The inherited Docker/PostgreSQL workspace tasks need the Cloudflare substitutions before they can be used for this target.

#### Setting up your first user

##### Approach 1

Open the application after its D1 schema and authentication configuration are ready. Use the setup/signup flow to create your first user.
This runs the existing password hashing, profile defaults, verification and admin policy instead of bypassing them with manual row edits.

##### Approach 2

Run the ported synthetic seed against local D1. It applies pending D1 migrations first, writes to the web Worker's local state, and adds no rows when run again. The [upstream seed](scripts/seed.ts) defines the dummy users above.

```sh
bun run --cwd packages/prisma db-seed:d1 --local-only
```

Do not use development seed accounts for a production installation.

### E2E-Testing

Point the retained Playwright runner at the vinext/workerd application and D1. Keep its existing assertions and scenarios.

Be sure to set the environment variable `NEXTAUTH_URL` to the correct value. If you are running locally, as the documentation within `.env.example` mentions, the value should be `http://localhost:3000`.

```sh
# In a terminal just run:
bun run test-e2e

# To open the last HTML report run:
bunx playwright show-report test-results/reports/playwright-html-report
```

The suite enables MailHog for the email journeys by default. Start the development mail receiver below before running the tests.

#### Development mail receiver

Run [mailhog](https://github.com/mailhog/MailHog) to view emails sent during development

   > **_NOTE:_** Required when `E2E_TEST_MAILHOG_ENABLED` is "1"

   ```sh
   docker pull mailhog/mailhog
   docker run -d -p 8025:8025 -p 1025:1025 mailhog/mailhog
   ```


#### Resolving issues

##### E2E test browsers not installed

Run `bunx playwright install` to download test browsers and resolve the error below when running `bun run test-e2e`:

```
Executable doesn't exist at /Users/alice/Library/Caches/ms-playwright/chromium-1048/chrome-mac/Chromium.app/Contents/MacOS/Chromium
```

### Upgrading from earlier versions

1. Pull the current version:

   ```sh
   git pull
   ```

1. Check if dependencies got added/updated/removed

   ```sh
   bun install --frozen-lockfile
   ```

1. Apply the reviewed D1 migrations in order. Back up production data and retain a recovery procedure before changing its schema.
   Use the local D1 database for development; do not run a development reset or seed against production.

1. Check for Worker variable, secret and binding changes

   ```sh
   bun run predev
   ```

1. Start the server. In a development environment, just do:

   ```sh
   bun run dev
   ```

   For a production build, run for example:

   ```sh
   bun run build
   bun run --cwd apps/web deploy
   ```

1. Enjoy the new version.

<!-- DEPLOYMENT -->

## Deployment

### Cloudflare Workers

Use the native vinext Cloudflare integration and each application's `vite.config.ts` and `cloudflare.config.ts`.
The [Cloudflare setup guide](docs/cloudflare.md) covers local development, secrets, D1 and deployment configuration.

#### Requirements

- **Cloudflare Workers Paid is required to deploy Cal.flare.**
- The web Worker uses the authoritative D1 database.
- `ASSETS` serves public files, fonts, embeds and built output.
- The web Worker uses `JOBS` and the selected cache bindings for Cloudflare job and cache resources.
- The docs application has its own static assets and no application database binding.

#### Deploying Cal.flare

Follow the [Cloudflare deployment procedure](docs/cloudflare.md#deploy-and-verify) for D1 migration ordering, resource bindings, application builds and provider verification.
Keep source configuration and ordered migrations in Git; generated build output and secrets stay outside it.

#### Configuration

##### Important Run-time variables

Provide these values through Worker bindings, variables and secrets:

| Variable or binding | Description | Required |
| --- | --- | --- |
| `DB` | D1 application/auth database. | required |
| `NEXT_PUBLIC_WEBAPP_URL` | Public web origin, consistent with client build configuration. | required |
| `NEXTAUTH_URL` | Public authentication origin and callback configuration. | required |
| `NEXTAUTH_SECRET` | Installation session/signing secret; generate during [Setup](#setup). | required |
| `CALENDSO_ENCRYPTION_KEY` | Stable 32-character Cal encryption key; generate during [Setup](#setup). | required |
| `CRON_API_KEY` | Authentication for retained cron HTTP endpoints. | where consumed |
| `EMAIL_FROM` | Sender identity for application mail. | for mail delivery |

Mail uses `RESEND_API_KEY`, `EMAIL_SERVER`, or the existing SMTP host/port/user/password fields.
Use a supported public TLS/STARTTLS relay on Workers; local sendmail is not available there.
Store private values as Worker secrets. Use ignored `.dev.vars` files for local development, and configure each consuming Worker.

##### Build-time variables

Provide consumed public values through the explicit client-build allowlist:

| Variable | Description | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_WEBAPP_URL` | Base URL injected into client output. | local development origin |
| `NEXT_PUBLIC_WEBSITE_URL` | Website origin where consumed. | application configuration |
| `NEXT_PUBLIC_EMBED_LIB_URL` | Public embed script URL. | application configuration |
| `NEXT_PUBLIC_WEBSITE_TERMS_URL` | Optional terms and conditions URL. | |
| `NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL` | Optional privacy-policy URL. | |
| `CALCOM_TELEMETRY_DISABLED` | Set to `1` to disable telemetry where consumed. | |

Rebuild client assets when a public build-time value changes. Auth, encryption and provider secrets remain server-side.
See the [environment inventory](docs/porting/inventory/environment.tsv) for retained names and the [architecture](docs/porting/architecture.md) for exact resource bindings.

#### Troubleshooting

##### SSL edge termination

Cloudflare handles public TLS. Keep the application/auth origins and provider callbacks consistent with the actual HTTPS domain.
Fix certificate, trust or URL configuration instead of disabling TLS verification.

##### Failed to commit changes: Invalid 'prisma.user.create()'

Inspect the actual input and D1/Prisma error for the failing field or relation. Preserve the original metadata, null and generated-ID contract.
Use the setup/signup service so password hashing and user defaults run; do not bypass those services with manual rows.

##### CLIENT_FETCH_ERROR

Check `NEXTAUTH_URL`, the public web origin, cookie domain/secure settings and installation secrets.
Inspect the Worker auth response and its `Set-Cookie` headers, then compare the original server/browser session projections.
Docker service-name and loopback-DNS workarounds are not the Worker routing model.

<!-- LICENSE -->

## License

Cal.flare is fully open source, licensed under the [MIT License](https://opensource.org/license/mit).

Unlike Cal.com's "Open Core" model, Cal.flare has **no commercial/enterprise code**. The entire codebase is available under the same open-source license.

## Enabling Content Security Policy

- Set CSP_POLICY="non-strict" env variable, which enables [Strict CSP](https://web.dev/strict-csp/) except for `unsafe-inline` in `style-src`. If you have custom changes in your instance, you may need to modify your code to make it CSP-compatible. Currently, strict CSP is enabled only on the login page. On other SSR pages, it is enabled in report-only mode to detect potential issues. It is not yet supported on SSG pages.

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

Rate limiting uses Unkey, as upstream does. Set `UNKEY_ROOT_KEY` to enable it. Without the key, rate limiting is off.

### Payments and automation

- [Stripe setup](packages/app-store/stripepayment/README.md) covers Connect OAuth and payment credentials.
- [HitPay](packages/app-store/hitpay/README.md), [PayPal](packages/app-store/paypal), [BTCPay](packages/app-store/btcpayserver) and [Alby](packages/app-store/alby) retain their own provider settings and signature rules.
- [Zapier](packages/app-store/zapier/README.md) and [Make](packages/app-store/make/README.md) describe API-key connections and webhook setup.

The community baseline contains Stripe webhook stubs. Registering credentials does not replace those stubs with payment fulfillment.
Check the [port plan](docs/porting/plan.md) for the in-scope payment behavior.

## Contributing

We welcome contributions! Whether it's fixing a typo, improving documentation, or building new features, your help makes Cal.flare better.

> **Important:** Cal.flare is a community fork. Contributions to this repo do **not** flow to Cal.com's production platform. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

- Check out our [Contributing Guide](./CONTRIBUTING.md) for detailed steps.
- Please follow our coding standards and commit message conventions to keep the project consistent.

Even small improvements matter — thank you for helping us grow!

### Good First Issues

We have a list of [help wanted](https://github.com/ralphbibera/cal.flare/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) that contain small features and bugs which have a relatively limited scope. This is a great place to get started, gain experience, and get familiar with our contribution process.

<!-- CONTRIBUTORS -->

### Contributors

<a href="https://github.com/ralphbibera/cal.flare/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ralphbibera/cal.flare" />
</a>

<!-- TRANSLATIONS -->

### Translations

Don't code but still want to contribute? help translate Cal.flare into your language.

<!-- ACKNOWLEDGEMENTS -->

## Acknowledgements

Cal.flare is built on the foundation created by [Cal.com](https://cal.com) and the many contributors to the original project. Special thanks to:

- [Vercel](https://vercel.com/)
- [vinext](https://vinext.dev/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [D1](https://developers.cloudflare.com/d1/)
- [Bun](https://bun.com/)
- [Day.js](https://day.js.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Prisma](https://prisma.io/)
