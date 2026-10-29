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
The organizer page edits the event title, URL slug, description, and duration with browser JavaScript.
Saving these details preserves scheduling rules and booking policies. Other settings currently
use the authenticated API. This editor is a functional checkpoint; upstream editor pixel parity remains open.
The private home page also lists the latest 1,000 bookings, newest recorded first, with attendee
details, times in the organizer's schedule timezone, and lifecycle status. Viewing this list
does not retry provider operations. It renders without JavaScript. With JavaScript enabled,
**Retry pending operation** explicitly resumes the booking's existing durable command and
reloads its current status. A failed or lost response leaves an explicit retry available.
Filters, pagination, other owner actions, and booking-list pixel parity remain migration work.

Authenticated `PATCH /api/owner/schedule` accepts `{ timeZone, rules }` for the current weekly
schedule. Each rule contains `weekday` (Sunday 0 through Saturday 6), `startMinute`, and
`endMinute` within that local day. Multiple nonoverlapping ranges per day are supported;
an empty rules array closes weekly availability. This update preserves event settings and
dated overrides. The private working-hours editor uses this endpoint to add or remove ranges,
change timezone, and close weekly availability. An end time of `00:00` represents minute 1440.
Failed saves retain the draft. Full editor pixel parity remains migration work.

Authenticated `PATCH /api/owner/overrides` replaces only the schedule's dated overrides.
Send `{ overrides: [{ date: "YYYY-MM-DD", ranges: [{ startMinute, endMinute }] }] }`.
Dates and minute ranges use the organizer's schedule timezone. Empty ranges close that date;
nonempty ranges replace its weekly hours. Send `{ overrides: [] }` to restore weekly hours
for every date. Event settings, timezone and weekly rules stay unchanged. The private
date-override editor supports dated closures and replacement intervals through this endpoint.
Saves are explicit, and failed saves retain the draft. Full editor pixel parity remains open.

Authenticated `PATCH /api/owner/booking-rules` replaces slot spacing, buffers, minimum notice
and guest change rules. Send all six fields: `intervalMinutes`, `beforeMinutes`, `afterMinutes`,
`noticeMinutes`, `disableCancelling` and `disableRescheduling`. The last two fields require
explicit booleans. Event details and all schedule fields stay unchanged. Accepted booking
commands retain their original replay and recovery behavior after a rules change.
The private booking-rules editor saves these fields explicitly and retains drafts after failed
saves. Full editor pixel parity remains migration work.

After the organizer connects Google and configures the event through the authenticated API,
open `/<event-slug>` to view its availability. The default slug is `intro`.
The slug `api` is reserved for application routes.
The page renders event details on the server, then loads the calendar in the browser.
Visitors can change their time zone and time format and select a UTC-backed time.
The searchable timezone control uses the browser's IANA catalogue and the pinned regional
aliases. Keyboard selection preserves the chosen zone identifier, including zones with equal
offsets. General city-database search and stored timezone preferences remain migration work.
The public page accepts attendee details and submits bookings with a saved request identity.
At widths through 768px, selecting a time opens a named native attendee dialog. Desktop month
forms stay inline. Fresh forms return to the browsing month and date with their draft and slot
focus preserved. Pending submissions cannot be dismissed. The dialog uses the pinned heading
and container styling; complete upstream attendee-form and dialog pixel parity remain open.
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
The attendee journey covers mobile dialog focus and dismissal, small-screen scrolling,
desktop inline forms, browsing-cursor continuity, and locked pending replay after reload.
It does not establish full-page pixel parity or live invitation delivery.

### Capture the pinned public page

The optional upstream reference runs the actual Next.js route in a separate checkout.
It uses the original dependency graph, Prisma and a disposable local PostgreSQL database.
It does not add Next.js to the Flare workspace or provide another deployment path.
Allow several GiB of disk space. Node 24.22.1, PostgreSQL tools and the existing Chromium
installation are required. The commands below use loopback ports 18796 and 18800;
both must be free. Do not point this fixture at an existing database or private configuration.

From the Flare repository root, prepare a clean reference checkout:

```sh
export CALFLARE_REFERENCE_ROOT=$(mktemp -d /tmp/calflare-reference.XXXXXX)
git worktree add --detach "$CALFLARE_REFERENCE_ROOT" 0f19cc46ef6b6426ee398c670575b3c96be7af9e
(cd "$CALFLARE_REFERENCE_ROOT" && HUSKY=0 DO_NOT_TRACK=1 TURBO_TELEMETRY_DISABLED=1 \
  mise exec node@24.22.1 -- node .yarn/releases/yarn-4.12.0.cjs install --immutable --mode=skip-build)
reference_pg=$(mktemp -d /tmp/calflare-reference-pg.XXXXXX)
initdb -D "$reference_pg/data" -U calflare_reference --auth-local=trust --auth-host=trust --no-locale -E UTF8
pg_ctl -D "$reference_pg/data" -l "$reference_pg/postgres.log" \
  -o "-h 127.0.0.1 -p 18796 -k $reference_pg" start
createdb -h 127.0.0.1 -p 18796 -U calflare_reference calflare_reference
(cd "$CALFLARE_REFERENCE_ROOT" && \
  export DATABASE_URL=postgresql://calflare_reference@127.0.0.1:18796/calflare_reference && \
  export DATABASE_DIRECT_URL=$DATABASE_URL && \
  mise exec node@24.22.1 -- node .yarn/releases/yarn-4.12.0.cjs prisma migrate deploy && \
  mise exec node@24.22.1 -- node .yarn/releases/yarn-4.12.0.cjs prisma generate)
(cd "$CALFLARE_REFERENCE_ROOT/apps/web" && mise exec node@24.22.1 -- node scripts/copy-app-store-static.js)
mise exec node@24.22.1 -- node apps/flare/scripts/fixtures/upstream/seed.cjs
mise exec node@24.22.1 -- node apps/flare/scripts/fixtures/upstream/server.cjs build
mise exec node@24.22.1 -- node apps/flare/scripts/fixtures/upstream/server.cjs start
```

The fixture checks the pin and clean tracked source, refuses private env files, and uses
fresh synthetic secrets. Its reference profile sets the server timezone to UTC, fixes Date to January 9, 2030 at noon UTC,
and preserves native timers. Next's selected-route compile mode builds the public page,
its profile-prefetch target and required APIs, then the normal production server runs it.
This targeted runtime build does not perform the complete upstream release build or type-check.
Page components, styles, fonts, queries and form implementations remain unchanged.
In another terminal, run the existing verifier against this server:

```sh
CALFLARE_REFERENCE_ORIGIN=http://127.0.0.1:18800 \
  mise exec -- node .yarn/releases/yarn-4.12.0.cjs verify:ui
```

This captures desktop/mobile calendars and slot-selected attendee forms twice, including
the native mobile dialog, using the same browser process as the component checks.
The browser disables partial rasterization through Chromium's supported
`--disable-partial-raster` switch. This selects
[full-tile rasterization](https://raw.githubusercontent.com/chromium/chromium/143.0.7499.4/third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc)
for both reference and candidate captures, excluding cached partial-tile updates from this profile.
The profile uses English, UTC, light theme, a 12-hour clock,
fresh browser storage and Playwright's static `animations: "disabled"` screenshots.
It waits for fonts, images, geometry and animation completion, then compares dimensions
and every RGBA channel without tolerance. Captures are ignored under `.verification`.
The initial day starts at 12:30pm under upstream's one-minute minimum notice fallback;
selecting January 10 exposes all sixteen 9am–4:30pm starts.
Temporary reservations are released through the original public cleanup API; no booking
is confirmed. Uncaught errors, console errors and HTTP failures fail verification.
This establishes repeatability of the declared static reference profile. Default-motion
stability, historical runtime equivalence, and live-provider behavior remain unverified.

The same command then opens the built Flare calendar with matched event details, weekly hours,
and fixed browser/Worker Date. It compares the initial card bounds and page background
against the actual reference at 1280px and 390px, and checks the same nine UTC slots.
It requires identical dimensions and zero differing RGBA pixels for both initial booking
cards and the entire initial mobile page. Other full-page states remain migration work.
The Worker clock override is confined to the test fixture and preserves native timers.
The public page bundles the Latin Inter font served by the reference's Next font loader.
Its served bytes and rendered title text metrics are compared with the actual reference.
The existing Inter OFL notice applies. Characters outside that subset keep the inherited font fallback.
This does not establish complete font or localization parity.
The selected day's background, text, and Today marker use the pinned default booking palette
and are checked against the actual light-theme reference. Shared component fixtures retain
their existing theme. Public dark-mode controls and custom branding remain separate work.
The month view follows the pinned 1040px document width at a 1024px viewport.
Selecting a day with sixteen slots preserves the reference's desktop card and scroll-container
bounds. Mobile keeps its natural list height and scrolls to the time panel on the first explicit
day selection per mounted calendar. Native focus scrolls the final desktop slot into
view, and Enter retains that slot's UTC identity when opening the attendee form.
Full-page pixels, other layouts, custom avatars, and organizer profile links remain separate work.

Stop the reference server with Ctrl-C and stop its database with
`pg_ctl -D "$reference_pg/data" stop`. Remove only these disposable resources when finished.

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
