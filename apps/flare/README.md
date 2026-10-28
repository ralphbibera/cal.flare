# Develop Cal.flare locally

The repository root runs the focused Astro/React/Workers port in this directory.
The inherited Cal.diy packages are outside the active workspace graph.
The root MIT license and Cal.com attribution continue to apply.

## Install and run

Use Node 24.22.1 and Yarn 4.12.0. `mise.toml` pins the project Node version without changing your global default.
With Mise installed, run these commands from the repository root:

```sh
mise install
mise exec -- node .yarn/releases/yarn-4.12.0.cjs install --immutable
mise exec -- node .yarn/releases/yarn-4.12.0.cjs dev
```

If Node 24.22.1 is already active, omit `mise exec --` from these commands.

Request `/api/health` on the printed local URL.
A successful response is `{"status":"ok","storage":"d1"}`.
It executes a query through the configured D1 binding.
No Cloudflare account, database provisioning, or Google credentials are needed for this local check.

For a built Worker, run `build` followed by `preview` through the same bundled Yarn command.
`preview` invokes local Wrangler against Astro's generated deployment configuration.
No deploy command is provided by the root scripts.

Open `/` to sign in with the Google account configured for this installation.
The private organizer page links to the public event preview. Sign-out revokes the current
session and returns to the sign-in page. These entry forms work without browser JavaScript.
Event and schedule editing currently use the authenticated API.

After the organizer connects Google and configures the event through the authenticated API,
open `/<event-slug>` to view its availability. The default slug is `intro`.
The slug `api` is reserved for application routes.
The page renders event details on the server, then loads the calendar in the browser.
Visitors can change their time zone and time format and select a UTC-backed time.
The public page accepts attendee details and submits bookings with a saved request identity.
Uncertain results retain that identity for a safe retry after reload. Acknowledged bookings
replace the pending attendee data with a private receipt in this tab's session storage.
The page distinguishes confirmed bookings from results needing recovery or organizer attention.
From that receipt, visitors can reschedule or cancel after confirmation.
Pending changes keep their request identity across reloads. Server-accepted changes
with uncertain provider outcomes expose status recovery instead of another mutation.
Use **Copy private booking link** to open the receipt in another browser without an account.
Anyone with this link can view or change the booking. The page removes the link fragment
after it saves access in that browser tab. Cancellation reasons remain migration work.
Fresh cancellations are refused after the booking ends. Previously accepted requests remain recoverable.
The authenticated settings API accepts optional `event.disableCancelling` and
`event.disableRescheduling` booleans; omitted flags preserve the existing enabled behavior.
Each flag refuses new requests for that action without changing accepted commands or their recovery.
Refusals use the existing HTTP 409 `invalid_slot` outcome and remain stable on replay.
Receipts and private management pages hide each disabled action after loading or refreshing
the booking. Existing saved attempts remain available for safe retry and reconciliation.
See [local configuration](SETUP.md) for the operator-owned OAuth requirements.

## Verify the focused port

Run these root scripts with the same Node/Yarn command:

```sh
mise exec -- node .yarn/releases/yarn-4.12.0.cjs type-check
mise exec -- node .yarn/releases/yarn-4.12.0.cjs type-check:ci --force
mise exec -- node .yarn/releases/yarn-4.12.0.cjs lint
mise exec -- node .yarn/releases/yarn-4.12.0.cjs test
mise exec -- node .yarn/releases/yarn-4.12.0.cjs test:sqlite
mise exec -- node .yarn/releases/yarn-4.12.0.cjs build
mise exec -- node .yarn/releases/yarn-4.12.0.cjs verify:worker
mise exec -- node .yarn/releases/yarn-4.12.0.cjs verify:ui
```

The browser verifier requires the build and Playwright's matching Chromium installation.
CI installs it with `yarn workspace @calflare/web exec playwright install --with-deps --only-shell chromium`.
It compares shared components with pinned upstream rendering and drives the public Astro page
through the built local Worker. Provider responses are controlled fixtures.
The page journey covers hydration, static assets, escaped event text, timezone selection,
UTC slot identity, receipt-based rescheduling and cancellation, and recovery after lost responses.
It also checks private-link access, reloads, denied access, and storage failures.
It does not establish full-page pixel parity or live invitation delivery.

The D1 verifier applies the experimental SQL file with Wrangler into temporary local storage.
The CI type-check accepts the inherited `--force` flag. Every invocation runs checks without a Turbo cache.
It executes the shared submission SQL through `getPlatformProxy` and a real local workerd D1 binding.
Named SQLite parameters are converted into positional D1 bindings.
It checks overlap rules, immutable replay, durable rejection, trigger and batch rollback, separate held ranges, and fifty concurrent batch pairs.
It disposes the runtime and removes its temporary database afterward.
This proves local binding behavior, not deployed D1 durability or concurrent HTTP booking requests.

Astro 7.4.2, Cloudflare adapter 14.4.2, and React 19.3.1 are pinned in the root lockfile.
The React integration is pinned to 7.0.0 with Vite React plugin 6.1.1.
Their OXC peer ranges agree. The newer integration/plugin combination declared incompatible peer ranges during setup.
The root no longer inherits the old Vite 6 override or legacy integration dependencies.

The [reservation model](../../experiments/d1-reservations/schema.sql) remains experimental.
The app includes owner OAuth, D1-backed sessions, authenticated settings, public availability,
booking lifecycle APIs, and scheduled recovery. The current model has one organizer, one event,
and the primary Google calendar. Broader account and feature parity remain migration work.
Generated Wrangler types and local state are ignored. The current D1 configuration is for local development.
Image transformation and Astro's default session storage are disabled.
Production resource configuration, deployed execution, live Google delivery, and measured
Workers Paid usage require separate verification and deployment authorization.
