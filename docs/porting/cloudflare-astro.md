# Cal.flare's first Cloudflare booking flow

This document records the original bounded migration plan and reservation experiments.
The current application and operator instructions are in the [development guide](../../apps/flare/README.md)
and [setup guide](../../apps/flare/SETUP.md).
The inspected baseline is Cal.diy commit `0f19cc46ef6b6426ee398c670575b3c96be7af9e`.
Cal.flare remains an independent MIT fork of [Cal.diy](https://github.com/calcom/cal.diy).
Retain the root [copyright and permission notice](../../LICENSE) when extracting code.
Bayanihan.dev and ralphbibera.com are the first intended users, not the product boundary.

## Current local checkpoint

The active Astro/Workers application supports one configured organizer and event.
It includes owner sign-in and settings, working hours and overrides, rolling booking limits,
selected conflict calendars, public booking, attendee and owner changes, calendar exports, and durable recovery.
Event operations use the primary Google calendar. Selected secondary calendars can block availability.
The local Worker/D1 and browser checks exercise these flows through the Google adapter with mocked responses.

Live Google consent, selected-calendar access, and invitation arrival still require operator-backed verification.
Deployment and production resource measurements require separate authorization and execution.
The local checkpoint establishes neither full Cal.diy parity nor suitability for a Cloudflare plan.
The proposals and increment descriptions below retain their original planning context.

## Reuse rules and replace application adapters

The source supports a portable scheduling module with explicit inputs for time, timezone, and configuration.
It does not support importing the existing booking services into a small Worker unchanged.

| Concern | Pinned source | Proposed treatment |
| --- | --- | --- |
| Range expansion, date overrides, DST, subtraction | `packages/features/schedules/lib/date-ranges.ts`, especially `buildDateRanges` and `subtract` | Extract selected algorithms with local domain types and their behavioral fixtures. |
| Half-open interval conflicts | `packages/features/bookings/lib/conflictChecker/checkForConflicts.ts` | Preserve adjacency and arbitrary overlap semantics. |
| Slot generation and notice | `packages/features/schedules/lib/slots.ts` | Replace implicit clock/configuration, Dayjs private timezone access, and Sentry wrapper with explicit inputs. |
| Availability orchestration | `packages/trpc/server/routers/viewer/slots/util.ts`, `packages/features/availability/lib/getUserAvailability.ts` | Replace Prisma, Redis, Node timing, DI, and Next/tRPC boundaries. |
| Busy periods and buffers | `packages/features/busyTimes/services/getBusyTimes.ts` | Preserve both events' before/after buffers. Exclude a rescheduled Google event by identity rather than subtracting an anonymous busy interval. |
| Booking lifecycle | `packages/features/bookings/lib/service/RegularBookingService.ts`, `packages/features/bookings/lib/handleNewBooking/createBooking.ts`, `packages/features/bookings/lib/EventManager.ts` | Replace orchestration. Keep one stable local booking ID and the existing Google event ID through reschedules. Upstream normally creates a replacement local row. |
| Owner auth and consent | `packages/features/auth/lib/next-auth-options.ts`, `packages/app-store/googlecalendar/api/callback.ts` | Replace NextAuth/Next API adapters and general signup/linking with a pinned organizer identity and mandatory one-use OAuth state. |
| Google integration | `packages/app-store/googlecalendar/lib/CalendarService.ts`, `CalendarAuth.ts` | Reuse payload and refresh-token merge rules as references. Use a narrow server-only transport rather than importing the integration catalog. |
| Persistence | `packages/prisma/index.ts`, `packages/prisma/schema.prisma` | Replace PostgreSQL/PrismaPg, native arrays, and date/time columns with a focused D1 model. Existing migrations are not portable. |

Useful source observations affect the new design:

- `packages/prisma/extensions/booking-idempotency-key.ts` protects exact accepted-booking tuples, not arbitrary overlapping intervals or command replay.
- Local booking creation precedes Google insertion. External references are saved later in `RegularBookingService.ts`. These separated writes need durable recovery.
- Google create/update/delete currently specify `sendUpdates: "none"`. The port will use native attendee updates explicitly and verify delivery.
- `CredentialDataService.ts` preserves plaintext `key` even when encryption succeeds. The refresh writer also updates plaintext. The port must encrypt persisted tokens without a plaintext fallback.
- The calendar callback can continue when `decodeOAuthState` returns `undefined`. Require a valid, expiring, browser-bound, single-use attempt before exchange.
- `packages/lib/availability.ts` uses a current-offset projection. Preserve date-specific timezone/DST expansion instead of treating that projection as future availability.

The existing DST, closure, subtraction, buffer, and conflict tests are extraction inputs, not passing evidence for the port.
Two working-hours cases in `date-ranges.test.ts` are skipped in the inspected source.
Add explicit fixtures for DST gaps/folds, half-hour zones, date overrides, notice boundaries, combined buffers, and all-day Google busy periods.

[Teddessert's scheduling-engine directory](https://github.com/modestapproach/teddessert-booking/tree/main/packages/scheduling-engine) and its README were inspected as a reference.
Its README attributes an extraction from a different Cal.diy revision, `180ede28`, and describes local Dayjs/type adaptations.
Its source and license coverage have not been fully audited here. No code from that repository is reused in this increment.
The other Cloudflare forks and research issues remain migration inventories, not runtime evidence for this fork.

## Proposed module and data boundaries

At the original planning checkpoint, the root workspace contained the Astro application at `apps/flare`
with the React integration configured. The root lockfile followed that focused graph.
Inherited source remained available for selective extraction. Reusable React calendar/time-picker
components and a framework-independent scheduling core were the next planned modules.
The proposed boundary assigned input parsing, owner or booking-management authorization, and
domain commands to Astro endpoints. Worker bindings owned D1 and secrets. The browser was to receive
public event data and slots, never credentials or secret API keys.
That boundary remained provisional pending Worker execution of the adapter and extracted scheduling code.
The current local Worker checkpoint is described above.

The table below preserves the original production data proposal, not the current schema or feature inventory.
The proposed destination flag does not describe current event routing.
These are not migrations added by the original reservation increment.

| Entity | Required data and purpose |
| --- | --- |
| Organizer | Public slug/name, IANA timezone, pinned Google issuer and subject. |
| Owner session | Hash of opaque token, organizer, expiry. No open signup for the first milestone. |
| OAuth attempt | Hashed state, browser/session binding, purpose, expiry, consumed state, PKCE verifier where supported. |
| Google connection | Granted scopes, encrypted token envelope with key version and nonce, normalized expiry, refresh version/ownership, connection status. OAuth client and encryption keys stay in Worker secrets. |
| Calendar selection | Connection/external calendar ID, conflict-check flag, destination flag. Use non-null scoped uniqueness. |
| Schedule and rules | IANA timezone, weekday/local-minute rows, date overrides including closures. Avoid PostgreSQL arrays and permanent UTC offsets. |
| Event type | Organizer, schedule, slug, title, duration, before/after buffers, slot interval, booking/reschedule notice. |
| Booking | Stable ID, version, lifecycle state, UTC start/end, visitor timezone/contact, event type, hashed management capability, Google calendar/event identity, iCalendar identity/sequence where used. |
| Reservation | Organizer, booking, current/candidate occupancy. Occupancy includes buffers and spans event types. |
| Command and calendar operation | Organizer-scoped request key, canonical payload identity, durable outcome, booking version, action, stable Google event target, retry/reconciliation state and attempt ownership. |

Separate desired state from confirmed Google state.
Reserve locally and persist the calendar intent atomically before contacting Google.
Allow at most one unresolved external mutation per booking.
Reschedule holds old and candidate occupancy until the same-event update is reconciled.
Cancellation releases occupancy only after confirmed event absence.
An ambiguous timeout or elapsed lease cannot release a reservation.
Local versions cannot fence a delayed Google write. Reconciliation must settle the earlier operation before a newer one starts.
FreeBusy plus insertion cannot exclude simultaneous writes by unrelated Google clients.

## Sequence small, verifiable increments

This sequence records the original dependency order. The current local flow implements the functionality
in steps 1 through 6. The deployment proof in step 7 remains outstanding.

1. **Reservation experiment.** Prove overlap exclusion, durable create intent, conflict outcomes, replay, and rollback with real SQLite. The original reservation increment implemented only that check.
2. **Workers execution.** The root now runs Astro 7 on Node 24 with a local D1 binding. The built `/api/health` endpoint queries D1 under Wrangler. The shared reservation SQL passes local D1 trigger, batch rollback, positional binding, immutable replay, and fifty concurrent batch-pair checks. Concurrent HTTP booking requests and deployed D1 behavior remain gates before production selection.
3. **Scheduling extraction.** Move selected MIT algorithms behind explicit types, clock, timezone, and configuration. Compare behavior against upstream fixtures. Add a public event page with a reusable React date/time picker. No database/network imports in the scheduling core.
4. **Owner configuration.** Add owner authentication, Google connection, encrypted refresh, calendar selection, event type, timezone, and working hours. Reject invalid/replayed OAuth attempts and stale token refresh writes.
5. **Complete create flow.** Recheck schedule and Google availability, reserve buffered occupancy, persist intent, create the event with native invitations, reconcile timeouts, and expose pending/failure states honestly. Add durable retry execution rather than relying on request lifetime or `waitUntil` alone.
6. **Reschedule and cancellation.** Mutate the same booking and Google event with version checks and scoped management capabilities. Race moves against creates/cancels and inject failures before/after each external write and local acknowledgment.
7. **Deployment proof and setup.** With deployment authorization, verify a real organizer and separate guest account, then measure the deployed artifact and account usage. Build a guided installer only after one documented setup works. Explain Google account/consent setup and token-lifetime requirements.

Follow the current [agent guide](../../AGENTS.md) for scope review and verification requirements.
Keep the existing upstream app intact while establishing the focused path. Do not install its full dependency graph for this experiment.
The root toolchain uses Astro, its Cloudflare and React integrations, React/React DOM, Wrangler, and TypeScript/type tooling.
The development guide describes the pinned versions and verification commands.
Focused CI verifies the Astro workspace. Inherited application workflows are preserved in `.github/legacy-workflows` outside the active graph.
Publication and deployment follow the repository's separate authorization requirements.

## Run the reservation experiment

From the repository root, run:

```sh
TZ=UTC python3 experiments/d1-reservations/verify.py
```

Python's standard library is sufficient. Temporary file databases are removed after the run.
`schema.sql` is an experimental model, not a production migration. `submit.sql` is the fixed admission sequence.
The Python runner supplies synthetic canonical payloads and IDs, wraps the statements in a local transaction, and checks committed state.
It does not branch between SQL statements based on query results.
The Node verifier at `apps/flare/scripts/verify-d1.mjs` adapts named parameters to positional D1 bindings and sends the fixed statements in one atomic `batch()`.
It applies the exact schema file with local Wrangler, then accesses its temporary database through `getPlatformProxy` and workerd.
D1 `exec()` rejected the multiline schema during verification. The migration-file command handles the schema's multiline statements and triggers.
Local `BEGIN`/`COMMIT` remain specific to the Python check.

The data shape is one immutable create command, zero or one current reservation, and zero or one pending create operation.
An after-insert trigger atomically records the accepted reservation and calendar intent, or a durable conflict without either side effect.
The overlap predicate uses half-open intervals and ignores event-type boundaries.
Matching replay returns the stored outcome and IDs. Changed payload or immutable fields abort. Replaying acceptance does not authorize a new Google call.
Canonical payload bytes are stored directly; hashing and production payload canonicalization are outside this experiment.
Candidate reservations demonstrate separate old/new occupancy, not a complete reschedule command.
Interval inputs here represent occupied time. The production adapter must derive buffered occupancy from trusted event settings.

For an existing seated occurrence, a seat request records immutable attendee identity and an accepted or conflicting result.
Its attendee claim consumes capacity while reusing the occurrence's organizer reservation and original create intent.
The pinned `addSeatToBooking` in `packages/features/bookings/lib/handleSeats/create/createNewSeat.ts` supplies the fresh-count and atomic attendee/seat contract.
The reference revision is `0f19cc46ef6b6426ee398c670575b3c96be7af9e`.
Durable replay, cross-kind key rejection, and rollback checks are additional safety rules.
This prototype supports positive fixed capacity. It does not implement occurrence-plus-first-seat creation, seat changes, or provider attendee-update delivery.

The checks protect project rules at the real SQLite boundary:

- Exact, partial, nested, and enclosing conflicts lose. Touching endpoints and other organizers can book.
- Fifty pairs of independent connections compete across event types. Each pair persists one winner, one conflict, and one operation. Lock errors fail the check.
- Simultaneous matching retries share one command and intent. Changed input under the same key fails, including after reopening the database.
- A stored conflict stays a conflict after the original blocker is removed.
- A failure while recording calendar intent rolls back the command and reservation too.
- Direct conflicting claim insertion and interval updates fail. Composite foreign keys reject mismatched organizers.
- Persisted old/candidate reservations block both ranges while leaving the gap bookable after connection reopening.
- Fifty final-seat races start with one attendee in a capacity-two occurrence. Exactly one contender wins, without another organizer reservation or create intent.
- Seat replay, changed canonical inputs, wrong-owner references, and injected admission failures preserve the expected state.

A removed overlap predicate, mutable request identity, lost transaction/trigger, or extra intent on replay should fail these checks.
No test double stands in for a database. Provider success is not simulated or claimed.
The experiment has no operation processor, production auth, availability calculation, cancellation/recovery implementation, or API.
The Node check establishes local D1 binding compatibility for these statements.
Neither check proves Google event deduplication, notification arrival, deployed D1 durability, or Worker CPU/memory limits.

## Verify the runtime and Free-plan claim separately

The owning [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/), retrieved on 2026-10-24, states 64 MiB uncompressed Worker size with gzip shown only for reference.
It also states 10 ms CPU per Free HTTP request, 128 MB memory, 100,000 requests/day, 50 external subrequests/request, and 25 MiB per static asset.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) include 500 MB per Free database and 50 queries per Free Worker invocation.
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) includes 5 million rows read/day, 100,000 rows written/day, and 5 GB total Free storage.
These limits are planning constraints, not measured application results. Recheck them at deployment time.

Use [Astro's Workers adapter](https://docs.astro.build/en/guides/deploy/cloudflare/) and [React integration](https://docs.astro.build/en/guides/integrations-guide/react/), then exercise the built artifact under Wrangler/workerd.
Inspect the server dependency graph and test every used runtime API. A successful bundling step alone is insufficient.
Record uncompressed upload size, largest asset, asset count, startup validation, actual request CPU/memory failures, D1 rows read/written, and retry/request volume.
Use deployed Worker telemetry for CPU. Local wall time or waiting for Google does not establish CPU-budget compliance.
Bound availability windows and test worst-case rule/busy-interval counts. Include OAuth, refresh, booking, reconciliation, and reschedule/cancel workloads.
Free suitability remains inconclusive until those paths run on the intended plan with representative traffic and headroom.

For Google, verify attendee arrival with [`sendUpdates=all`](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and a stable client-selected event identity.
Use the same identity for timeout reconciliation, and verify ownership before treating a duplicate-ID response as prior success.
Start with native Google invitations. Defer branded confirmation emails to avoid a second delivery system in the first flow.
Do not promise exactly-once invitation email delivery under retries.
Resolve the appropriate [OAuth production/personal/internal path](https://developers.google.com/identity/protocols/oauth2#expiration). External Testing Calendar refresh tokens can expire after seven days.
Guests need no Google authorization. Meet creation/support remains optional until independently verified.

## Capture the pinned public page

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

The seed retains `/reference/intro` and its daily 09:00–17:00 UTC availability.
It also creates an isolated `confirmation-reference` organizer, schedule, and event, with
one accepted, nonrecurring booking at January 10, 2030, 09:00–09:30 UTC.
The fixed route is `/booking/calflare-confirmation-reference-20300110`.
Its host is `confirmation-organizer@reference.invalid`; its sole attendee is `primary@example.invalid`.
The event has no locations or provider credentials. The main organizer has no bookings.
These are local fixture records, not production application data.

To rerun the seed against an already prepared reference checkout, keep `CALFLARE_REFERENCE_ROOT`
set to that checkout's path:

```sh
CALFLARE_REFERENCE_ROOT="$CALFLARE_REFERENCE_ROOT" \
  mise exec -- node apps/flare/scripts/fixtures/upstream/seed.cjs
```

The seed always targets the hardcoded loopback `calflare_reference` database on port 18796.
It accepts an empty booking table or the exact known booking and attendee relations.
Unknown users, foreign or changed bookings, and any provider credentials fail closed.
A transaction rolls back incomplete runs. Repeated seeds retain two users, two events,
two schedules, one attendee, and one booking without adding duplicates.

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

The same optional path visits the native confirmation route from the unchanged
`BookingsSingleView` at pin `0f19cc46ef6b6426ee398c670575b3c96be7af9e`.
It captures the whole page twice in fresh contexts at 390px and 1280px and requires identical
dimensions and zero differing RGBA pixels. It checks the scheduled heading, What/When/Who,
UTC interval, identities, synthetic notes, and ordered Reschedule/Cancel actions without clicking them.
This booking fixture has no images, so its focused readiness check waits for loaded fonts,
stable geometry, and completed animations without changing the public-page image requirement.
Read-only SQL checks preserve booking content and counts and require zero credentials after each visit.
The browser permits only local reads and the source-backed session and feature-map queries.
Visible email-sent wording is fixture UI content. No booking is created through the UI and no invitation is sent.
This is reference baseline evidence only. Candidate confirmation parity and full-port completion remain unverified.
Without `CALFLARE_REFERENCE_ORIGIN`, the existing verifier skips native checks.
That default path needs no native Prisma graph or PostgreSQL connection.

The same command also opens the built Flare calendar with matched event details, weekly hours,
and fixed browser/Worker Date. It compares the initial card bounds and page background
against the actual reference at 1280px and 390px, and checks the same nine UTC slots.
It requires identical dimensions and zero differing RGBA pixels for both initial booking
cards and the entire initial mobile page. Other full-page states remain migration work.
The Worker clock override is confined to the test fixture and preserves native timers.
The public page bundles the Latin Inter font served by the reference's Next font loader.
Its served bytes and rendered title text metrics are compared with the actual reference.
The existing Inter OFL notice applies. Characters outside that subset keep the inherited font fallback.
This does not establish complete font or localization parity.
Public booking `font-cal` headings use the unmodified 40,932-byte CalSans-SemiBold asset
from the pinned Next source, registered as `Cal Sans Booking` with normal style, weight 600,
`display: block`, and a public-route preload. Heading CSS retains weight 400.
The font remains under SIL OFL 1.1, with the entire historical copyright and commissioning
notice in [`apps/flare/public/fonts/CalSans-OFL.txt`](../../apps/flare/public/fonts/CalSans-OFL.txt), copied verbatim from
[calcom/sans at c7f20266](https://github.com/calcom/sans/blob/c7f20266c2f903821238fc3fe744ded53302a3b1/OFL.txt).
The font SHA-256 is `d3e38c946c6c0299f321b6cf2c92f7f26e202530f49d6bc86d52e9fd74f393a2`.
The actual Next comparison resolves each heading's first family through CSSOM, checks its
loaded face and HTTP font bytes against the pinned source, and compares the mobile dialog
heading's DOM Range dimensions and computed typography after fonts are ready.
The default built-page submission journey checks the same served identity and observed
native heading metrics without Next, including the shared wide week dialog, and serves the full notice.
This establishes font identity and heading typography only. Whole-dialog pixels remain separate work.
The default built-page journey also checks blank attendee composition at 390, 768, 900, and 1280px,
including literal January 10 at 09:00 UTC, duration, agreement text and links, logical order,
and the sticky footer's computed border, background, and padding. The submission journey checks
the agreement links in keyboard order and keeps fields and actions reachable at 390×240.
The optional actual Next comparison requires zero differing RGBA pixels in three mobile regions.
Those regions are the appointment badge union, the agreement content bounds, and the footer bounds.
Content, region dimensions, and computed styles are checked before comparing pixels.
Flare intentionally retains a visible timezone absent from the native badge header.
These partial comparisons establish neither whole-header nor whole-dialog equality.
The selected day's background, text, and Today marker use the pinned default booking palette
and are checked against the actual light-theme reference. Shared component fixtures retain
their existing theme. Public dark-mode controls and custom branding remain separate work.
The month view follows the pinned 1040px document width at a 1024px viewport.
Selecting a day with sixteen slots preserves the reference's desktop card and scroll-container
bounds. Mobile keeps its natural list height and scrolls to the time panel on the first explicit
day selection per mounted calendar. Native focus scrolls the final desktop slot into
view, and Enter retains that slot's UTC identity when opening the attendee form.
Full-page pixels, other layouts, custom avatars, and organizer profile links remain separate work.

The desktop month attendee check establishes **PARTIAL FORM-REGION parity** only.
At 1280×900 it selects January 10, 2030 at 09:00 UTC with blank fields and closed guests.
The union of the Email address label and input, Additional notes label and textarea,
and closed Add guests button is exactly x625, y296, 371×236 in both actual Next and built Flare.
Literal assertions check the scenario, labels, required markers, blank values, closed guests,
input fonts, 760×450 booking card, 420×448 inline panel, and 371px form width before the
dimension and every-RGBA-channel comparison requires zero differences.
The public labels reuse `your_name` and `email_address`; generic labels remain available to other flows.
Name keeps its existing autofocus, unlike the native desktop form. Its focus outline is outside
the declared comparison. Metadata, toolbar, complete form, and whole-dialog pixels remain separate work.
No complete form, page, mobile, or live-provider parity follows from this partial comparison.

Stop the reference server with Ctrl-C and stop its database with
`pg_ctl -D "$reference_pg/data" stop`. Remove only these disposable resources when finished.
