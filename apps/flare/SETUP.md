# Configure and run Cal.flare

Install dependencies with the [development quickstart](../../README.md#development) first.
Follow the local steps below, then the production steps when you are ready to deploy.
The setup generator writes local configuration. It never provisions resources or deploys code.

Run commands from the repository root with Node 24.22.1 and Yarn 4.12.0.
If you use Mise, prefix each command with `mise exec --`.
Every `yarn` command below means the bundled `node .yarn/releases/yarn-4.12.0.cjs`.
For example, `yarn build` becomes `mise exec -- node .yarn/releases/yarn-4.12.0.cjs build`.

## Create local configuration

Run the guided generator.

```sh
yarn setup
```

The generator asks for `PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_OWNER_EMAIL`.
The default origin is `http://localhost:4321`.
Use the exact origin without a trailing slash or path.
Only the configured owner can authenticate.
People booking time will not need to sign in.

The generator creates `apps/flare/.dev.vars` with owner-only permissions, mode `0600`.
It generates `TOKEN_ENCRYPTION_KEY` from 32 cryptographically random bytes encoded as base64.
It refuses to overwrite an existing file, including a symbolic link.
To change existing values, edit the file privately.
Keep the encryption key stable so stored tokens remain decryptable.
Do not commit the file or paste its contents into logs, chat, or shell commands.

Node's built-in readline input echoes characters.
The generator therefore leaves `GOOGLE_CLIENT_SECRET` blank instead of asking you to paste it into the terminal.
Open `.dev.vars` in a private editor and replace the empty quoted value with your real Google client secret.
Fill any other blank Google fields there.

To create the file without prompts or Google credentials, run the following command.
This creates blank Google fields and a random encryption key. Google integration remains pending.

```sh
yarn setup --local
```

After editing the file, check that every required variable has a nonempty value.
The check prints variable names only and exits unsuccessfully if a required value is missing.
This checks only that required local variables are nonempty, not their formats, credentials, Google access, or production readiness.

```sh
yarn setup --check
```

## Configure Google Calendar access

1. Open the [Google Cloud console](https://console.cloud.google.com/) and select your project.
2. Enable the **Google Calendar API** under **APIs & Services > Library**.
3. Configure the app name, support email, and audience in **Google Auth Platform**.
4. For a personal Google account, choose **External**. While the app is in **Testing**, add `GOOGLE_OWNER_EMAIL` as a test user.
5. Configure `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.events.freebusy`, and `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. These are the Calendar scopes requested by this app. Event access permits primary-calendar event operations; the other grants support shared-calendar busy access and private calendar discovery.
6. Include the identity scopes `openid`, `email`, and `profile`.
7. Under **Clients**, create an OAuth client with application type **Web application**.
8. Add `http://localhost:4321/api/auth/callback` as an authorized redirect URI for local development.
9. For deployment, add your exact HTTPS `PUBLIC_ORIGIN` followed by `/api/auth/callback` to the same client or a separate production client.
10. For local use, copy the client ID into `GOOGLE_CLIENT_ID` and the client secret into `GOOGLE_CLIENT_SECRET` in your private editor.

For an External app in Testing that requests Calendar scopes, Google refresh tokens expire after seven days.
For ongoing personal use, move the External app to **In production** and follow Google's applicable verification requirements.
Personal use with a small audience can qualify for a verification exception, but an unverified-app warning can remain.
An eligible Google Workspace organization can instead choose **Internal** for users within that organization.
Internal is not available to a personal Gmail account.
See [Google's OAuth token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration) and [verification exceptions](https://support.google.com/cloud/answer/13464323).

Use owner sign-in to authorize Google Calendar. Existing installations must update the consent
screen scopes above and sign in again for private calendar discovery. The browser-bound PKCE
flow requests incremental consent with `include_granted_scopes=true`. Refreshing an old token
does not add scopes. Missing or denied consent leaves the previous connection and sessions
intact, so existing primary-calendar flows remain usable. Equivalent broader Calendar grants
are accepted only when they cover event writes, selected-calendar free/busy and CalendarList.
The old `calendar.freebusy` grant alone does not satisfy selected-calendar free/busy access.
No stored scope inventory is inferred or migrated. Live consent and provider access require
operator verification and have not been established by local mocked-provider checks.
The private home **Conflict calendars** control loads the owner-only discovery endpoint separately
and saves selected conflict calendars explicitly. **Reconnect Google** starts the existing sign-in
flow after a discovery failure. Check the consent configuration above if access remains unavailable.
A nonempty selection requires the new discovery grant before saving and selected-calendar
free/busy access when checking availability. Resetting to the primary default or an explicit
empty selection does not require CalendarList access. Empty selection still enforces local
booking reservations. Unavailable saved IDs remain visible until you remove them and save.
**Clear selection** requires Save; **Reset to primary** saves immediately. Event operations and remote
reconciliation still target the primary calendar.
The setup command does not run OAuth for you.
The first successful owner login pins the Google subject in D1.
Changing `GOOGLE_OWNER_EMAIL` alone does not transfer ownership to another Google account.
Booking create, reschedule, and cancel requests ask Google to notify attendees with `sendUpdates=all`.
Native Google invitations do not require a separate email provider.
Future account-verification or password-recovery mail would need a mail transport.
Those account flows and SMTP configuration are not prerequisites for the current Google-owner deployment.

## Apply local migrations and start the app

Apply migrations to local D1 storage, then start development.
These commands do not provision a remote database.

```sh
yarn workspace @calflare/web exec wrangler d1 migrations apply calflare --local --config wrangler.jsonc
yarn dev
```

Open `http://localhost:4321`.
The current foundation exposes its D1 health endpoint at `/api/health`.
After a build, `yarn preview` starts local Wrangler against the generated Worker configuration.

## Deploy to Cloudflare Workers

These steps change your Cloudflare account. Execute them only for the installation you intend to operate.
Use Worker name `calflare`, D1 database name `calflare`, and binding `DB` consistently below.
Keep the production encryption key and recovery information in private storage before accepting bookings.

### 1. Confirm the account and hostname

Authenticate and inspect the account before creating resources.

```sh
yarn workspace @calflare/web exec wrangler login --config wrangler.jsonc
yarn workspace @calflare/web exec wrangler whoami --config wrangler.jsonc
```

Confirm the printed account ID against the intended account in the Cloudflare dashboard.
Set `account_id` in source `apps/flare/wrangler.jsonc` to that ID, especially if you have access to several accounts.
In **Workers & Pages**, confirm or register the account's Workers subdomain.
The supported default URL is `https://calflare.<YOUR_WORKERS_SUBDOMAIN>.workers.dev`.
Replace the placeholder with your actual subdomain and use that exact HTTPS origin as `PUBLIC_ORIGIN`.
Do not use a preview-version URL, a path, or a trailing slash.

### 2. Create or select D1 and edit source configuration

For a new installation, create the database in the confirmed account.
For an existing installation, use its database UUID from the dashboard instead of creating a replacement.

```sh
yarn workspace @calflare/web exec wrangler d1 create calflare --config wrangler.jsonc --update-config=false
```

Creation prints the database UUID. Merge the following fields into `apps/flare/wrangler.jsonc`.
Replace every placeholder with the actual nonsecret value. Replace the existing `d1_databases` entry rather than adding a second `DB` binding.
Retain the existing `main`, compatibility settings, assets, and `triggers.crons` fields.

```jsonc
{
	"name": "calflare",
	"account_id": "<CLOUDFLARE_ACCOUNT_ID>",
	"workers_dev": true,
	"d1_databases": [{
		"binding": "DB",
		"database_name": "calflare",
		"database_id": "<D1_DATABASE_UUID>",
		"migrations_dir": "./migrations"
	}],
	"vars": {
		"PUBLIC_ORIGIN": "https://calflare.<YOUR_WORKERS_SUBDOMAIN>.workers.dev",
		"GOOGLE_CLIENT_ID": "<PRODUCTION_GOOGLE_WEB_CLIENT_ID>",
		"GOOGLE_OWNER_EMAIL": "<VERIFIED_OWNER_EMAIL>"
	}
}
```

The checked-in source has no production database UUID or variables. Do not rely on automatic resource provisioning.
The eight production migrations are `0001_identity.sql` through `0008_public_profile.sql` in `apps/flare/migrations`.
Use these migrations, not the reservation experiment or inherited Prisma schema.

### 3. Configure production Google access and secrets

Complete [Google Calendar access](#configure-google-calendar-access) for the production web client and owner.
Register the exact redirect URI `https://calflare.<YOUR_WORKERS_SUBDOMAIN>.workers.dev/api/auth/callback` with your real subdomain.
Its origin must equal `PUBLIC_ORIGIN`, and its client ID must match the source configuration.
Keep the production client secret out of source files and command arguments.

Generate a separate production key with a trusted cryptographic generator in a private password-manager or editor workflow.
Encode exactly 32 random bytes as canonical standard base64, including its final `=` padding.
The result has 44 characters. Do not use base64url or a passphrase.
Retain the key privately and keep it stable. Replacing it makes existing encrypted Google tokens unreadable.
Enter the client secret and that retained key only at Wrangler's private prompts.

```sh
yarn workspace @calflare/web exec wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.jsonc
yarn workspace @calflare/web exec wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.jsonc
```

Confirm both commands succeed for Worker `calflare` in the selected account.
Wrangler can create an undeployed Worker when setting its first secret.
Local `.dev.vars` is not uploaded as production secrets, and `yarn setup --check` does not inspect these secrets.

### 4. Apply remote migrations, build, and deploy

Confirm the source account ID and database UUID before applying migrations to remote D1.
For an existing installation, first follow [Upgrade and recover](#upgrade-and-recover).

```sh
yarn workspace @calflare/web exec wrangler d1 migrations list calflare --remote --config wrangler.jsonc
yarn workspace @calflare/web exec wrangler d1 migrations apply calflare --remote --config wrangler.jsonc
yarn workspace @calflare/web exec wrangler d1 migrations list calflare --remote --config wrangler.jsonc
yarn build
yarn workspace @calflare/web exec wrangler deploy --config dist/server/wrangler.json
```

On a fresh database, the first list shows eight unapplied migrations. After application, the last list shows none pending.
The build must run after the production source edits. Astro generates `apps/flare/dist/server/wrangler.json`
with `entry.mjs`, assets at `../client`, and the D1 migrations path at `../../migrations`.
The custom `src/worker.ts` entry preserves Astro fetch handling and scheduled recovery.
Confirm generated `DB` targets your UUID, the variables match your origin and client, and the cron remains `*/5 * * * *`.
Never edit `dist` or `.wrangler` files. Correct the source and rebuild instead.
Deploy uses the generated configuration explicitly and prints the deployed URL and version.
Confirm the URL equals your chosen origin before starting acceptance.

Wrangler also supports the generated `.wrangler/deploy/config.json` redirect for autodiscovery.
The command above uses one explicit route. There is no root deploy alias.
The current source has one default target. Existing CI runs checks and does not deploy automatically.
If you later add named environments, Astro selects them with `CLOUDFLARE_ENV` at build time.
Deploying with `--env` alone cannot select another environment in an already built artifact.
See [Astro Workers deployment](https://docs.astro.build/en/guides/deploy/cloudflare/)
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

For an optional custom domain, attach it to this Worker in **Settings > Domains & Routes** and confirm HTTPS works.
Before signing in there, update source `PUBLIC_ORIGIN` and the Google callback to the exact custom origin,
then rebuild, deploy, and repeat acceptance on that hostname. Use one canonical origin for owner sessions and booking links.

## Accept the deployed installation

Record the deployed version, origin, account, database UUID, and the results below without secrets or private booking links.
Treat every unchecked item as unverified. Local fixtures and dry runs cannot complete this checklist.

1. Open the chosen HTTPS origin. Confirm the sign-in page, styles, scripts, and fonts load without failed asset requests.
2. Request `/api/health` on that origin. Expect HTTP 200 and `{"status":"ok","storage":"d1"}`.
   This runs `SELECT 1`. It proves binding access, not application tables, migrations, OAuth, or Google delivery.
3. Run the remote migrations-list command above. Expect no pending migrations, including all eight app migrations on a fresh installation.
4. Sign in with the configured Google owner and approve the requested scopes. Expect the private organizer page.
   Reload to check the session, then sign out and confirm private pages require sign-in. Sign in again.
5. Load **Conflict calendars**. Confirm eligible Google calendars appear, select the intended conflict calendars, save, and reload.
   Verify the saved selection. **Reset to primary** restores the primary default. An empty selection ignores external busy time but keeps local holds.
6. Save event details, working hours, timezone, and booking rules. Open the linked public event in a signed-out browser.
   Expect the saved title and duration, valid slots in the chosen timezone, and exclusion of known selected-calendar busy intervals.
7. Only with explicit permission to create a real booking and send Google invitations, use a separate guest mailbox you control.
   Submit one booking. Confirm the app reaches confirmed status and the owner's primary Google calendar has the matching event and attendee.
   Check invitation arrival in the guest inbox, including spam. Record app confirmation, remote event, and email arrival separately.
8. With the same permission, reschedule that booking through its private guest link and confirm the changed time in the app and Google.
   Then cancel with a reason and confirm cancellation in both places. Inspect guest update and cancellation messages separately.
   Keep private management links private. Do not use unrelated attendees for acceptance.
9. In the Worker's dashboard, confirm the registered `*/5 * * * *` Cron Trigger and inspect scheduled invocation outcomes.
   Confirm successful scheduled execution after registration propagates. An HTTP health response does not exercise the scheduled handler.

Google requests use `sendUpdates=all`. A successful API write does not prove email arrival or exactly-once notification delivery.
An app command can remain pending or show attention while provider results are uncertain.
Do not create another booking to retry that command. Use the existing booking's **Retry pending operation** after diagnosing the cause.

## Operate scheduled recovery

Keep the custom Worker entry and `*/5 * * * *` trigger when changing configuration.
The handler selects at most five due commands per run. Leases, exponential backoff, provider errors,
and queue size can delay completion beyond five minutes. The schedule is not a completion guarantee.
Inspect pending and attention states in the private owner booking views.
After correcting access or configuration, the owner's retry control resumes the same durable command.
Reads of owner bookings do not retry writes.

Use **Cron Events** for recent scheduled invocation history and existing dashboard logs or a live tail for exceptions.
Run `yarn workspace @calflare/web exec wrangler tail --config wrangler.jsonc` while reproducing an authorized operation.
Protect logs that contain personal data. Compare invocation outcomes with the booking's app state and remote Google event.
Check Workers requests, CPU, errors, and D1 storage, rows read, and rows written against the account's current limits and pricing.
Collect deployed usage before choosing a plan. This guide establishes no Free or Paid plan suitability.
See [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
and [Workers logs](https://developers.cloudflare.com/workers/observability/logs/).

## Upgrade and recover

1. Record the current Worker version and keep a recoverable copy of the deployment's nonsecret source configuration.
   Preserve production D1 data and the original encryption key in private recovery storage.
2. Review the release diff and migrations before updating the checkout. Confirm a usable D1 backup or Time Travel bookmark before schema changes.
   Retrieve the current bookmark with `yarn workspace @calflare/web exec wrangler d1 time-travel info calflare --config wrangler.jsonc`.
   Retain that bookmark with the release version and time in your private recovery records.
   [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) retains seven days on Free and thirty days on Paid.
   Check the current account plan and retention before relying on a recovery point.
3. Install the selected release with `yarn install --immutable`. Restore its intended production configuration without replacing the encryption key.
4. List and apply remote app migrations with the source-config commands above. Rebuild with `yarn build`, then deploy the generated config.
5. Repeat deployed acceptance. Perform real guest writes and notification checks only with the required permission.

[Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) can redeploy a previous compatible Worker version.
Rollback selects that version's code and versioned configuration, including bindings and secrets.
Resource or binding changes can prevent rollback. Wrangler can block rollback after secret changes and request confirmation.
Before confirming, check the target version's bindings, OAuth credentials, and encryption key against the current D1 data and schema.
An older encryption key may not decrypt the stored credentials. Inspect secret configuration privately without printing secret values.
Worker rollback does not restore D1 data or undo Google events and messages.
A blind D1 restore can revert durable booking commands after Google has already changed.
Reconcile app commands with remote events before choosing a restore. Do not use database reset or token-key replacement as routine troubleshooting.

If health fails, inspect the deployed `DB` binding, account, and database UUID.
If health passes but app tables fail, inspect remote migration status.
For OAuth failures, compare the exact origin, registered callback, client pair, consent scopes, and configured owner.
Testing-mode token expiry can require Google reauthorization. A different Google subject cannot replace the pinned owner by changing email alone.
For asset failures or stale variables, correct source configuration and rebuild before deploying.
For pending commands, inspect scheduled outcomes, Google access, and the remote event before using the existing retry control.
