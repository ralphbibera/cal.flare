# Configure and run Cal.flare

This checkout provides a local Workers/D1 booking app with owner sign-in.
The setup command prepares private configuration for Google Calendar access.

Run commands from the repository root with Node 24.22.1 and Yarn 4.12.0.
If you use Mise, prefix each command with `mise exec --`.
Use `node .yarn/releases/yarn-4.12.0.cjs` in place of `yarn` if Corepack is unavailable.

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
It does not verify credentials, Google access, or deployment readiness.

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
10. Copy the client ID into `GOOGLE_CLIENT_ID` and the client secret into `GOOGLE_CLIENT_SECRET` in your private editor.

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
That flow will request Google's native attendee notifications with `sendUpdates=all`.
Native Google invitations do not require a separate email provider.
Application mail, including account verification and password recovery, will require an operator-configured mail transport.

## Apply local migrations and start the app

Apply migrations to local D1 storage, then start development.
These commands do not provision a remote database.

```sh
yarn workspace @calflare/web exec wrangler d1 migrations apply calflare --local
yarn dev
```

Open `http://localhost:4321`.
The current foundation exposes its D1 health endpoint at `/api/health`.
After a build, `yarn preview` starts local Wrangler against the generated Worker configuration.

## Configure deployment manually

Perform these steps only when you choose to deploy to your Cloudflare account.
The setup generator never provisions resources or deploys code.

1. Create or select the production D1 database in your Cloudflare account.
2. Set its actual `database_id` on the `DB` binding in `apps/flare/wrangler.jsonc`.
3. Set the production `PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_OWNER_EMAIL` as Worker variables in the Wrangler configuration.
4. Add the production Google redirect URI in the Google console.
5. Run the following commands and enter each secret at Wrangler's private prompt.

```sh
yarn workspace @calflare/web exec wrangler secret put GOOGLE_CLIENT_SECRET
yarn workspace @calflare/web exec wrangler secret put TOKEN_ENCRYPTION_KEY
```

Use a separate cryptographically random 32-byte base64 encryption key for production.
Create and retain the key privately in a password manager or local editor workflow.
Keep that key stable and separate from the local development key.
Wrangler does not upload `.dev.vars` as production secrets.

When you are ready to change the remote database, explicitly run its migrations.
Confirm the target Cloudflare account and D1 binding first.

```sh
yarn workspace @calflare/web exec wrangler d1 migrations apply calflare --remote
```

Build and deploy only as a separate, deliberate action after checking the production configuration.
Local validation does not establish deployed behavior, Google delivery, or service-plan costs and limits.
