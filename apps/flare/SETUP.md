# Configure and run Cal.flare

This checkout currently provides a local Workers/D1 foundation and scheduling helpers.
The setup command prepares private configuration for the Google booking flow.
Owner sign-in and booking screens will be available in later migration checkpoints.

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
The first Google booking flow will allow only the configured owner to authenticate.
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
5. Configure `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.freebusy`. These are the Calendar scopes requested by this app. Event access also permits reading primary-calendar events.
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

Once the Google booking flow is available, use owner sign-in to authorize Google Calendar.
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
