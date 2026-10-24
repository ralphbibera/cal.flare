# Cal.flare's first Cloudflare booking flow

This is a bounded migration plan with a local Astro/Workers foundation and experimental reservation checks.
It does not establish a complete booking application or Cloudflare Free deployment.
The inspected baseline is Cal.diy commit `0f19cc46ef6b6426ee398c670575b3c96be7af9e`.
Cal.flare remains an independent MIT fork of [Cal.diy](https://github.com/calcom/cal.diy).
Retain the root [copyright and permission notice](../../LICENSE) when extracting code.
Bayanihan.dev and ralphbibera.com are the first intended users, not the product boundary.

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

The active root workspace contains the Astro application at `apps/flare` with the React integration configured.
The root lockfile now follows that focused graph. Inherited source remains available for selective extraction.
The next modules are reusable React calendar/time-picker components and a framework-independent scheduling core.
Astro endpoints parse input, enforce owner or booking-management authorization, and invoke domain commands.
Worker bindings own D1 and secrets. The browser receives public event data and slots, never credentials or secret API keys.
This boundary is provisional until the adapter and extracted scheduling code run under Workers.

The minimum production data model is proposed below. These are not migrations added by this increment.

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

1. **Reservation experiment.** Prove overlap exclusion, durable create intent, conflict outcomes, replay, and rollback with real SQLite. This increment implements that check only.
2. **Workers execution.** The root now runs Astro 7 on Node 24 with a local D1 binding. The built `/api/health` endpoint queries D1 under Wrangler. The shared reservation SQL passes local D1 trigger, batch rollback, positional binding, immutable replay, and fifty concurrent batch-pair checks. Concurrent HTTP booking requests and deployed D1 behavior remain gates before production selection.
3. **Scheduling extraction.** Move selected MIT algorithms behind explicit types, clock, timezone, and configuration. Compare behavior against upstream fixtures. Add a public event page with a reusable React date/time picker. No database/network imports in the scheduling core.
4. **Owner configuration.** Add owner authentication, Google connection, encrypted refresh, calendar selection, event type, timezone, and working hours. Reject invalid/replayed OAuth attempts and stale token refresh writes.
5. **Complete create flow.** Recheck schedule and Google availability, reserve buffered occupancy, persist intent, create the event with native invitations, reconcile timeouts, and expose pending/failure states honestly. Add durable retry execution rather than relying on request lifetime or `waitUntil` alone.
6. **Reschedule and cancellation.** Mutate the same booking and Google event with version checks and scoped management capabilities. Race moves against creates/cancels and inject failures before/after each external write and local acknowledgment.
7. **Deployment proof and setup.** With deployment authorization, verify a real organizer and separate guest account, then measure the deployed artifact and account usage. Build a guided installer only after one documented setup works. Explain Google account/consent setup and token-lifetime requirements.

Each code increment targets fewer than 500 changed code lines and fewer than 10 code files.
Keep the existing upstream app intact while establishing the focused path. Do not install its full dependency graph for this experiment.
The root toolchain uses Astro, its Cloudflare and React integrations, React/React DOM, Wrangler, and TypeScript/type tooling.
The development guide describes the pinned versions and verification commands.
Inherited GitHub workflows still reference legacy packages. Migrate CI in a separate reviewed step before publishing changes.
No commit, PR, push, or deployment is part of these increments.

## Run the reservation experiment

From the repository root, run:

```sh
TZ=UTC python3 experiments/d1-reservations/verify.py
```

Python's standard library is sufficient. Temporary file databases are removed after the run.
`schema.sql` is an experimental model, not a production migration. `submit.sql` is the fixed create-command sequence.
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

The checks protect project rules at the real SQLite boundary:

- Exact, partial, nested, and enclosing conflicts lose. Touching endpoints and other organizers can book.
- Fifty pairs of independent connections compete across event types. Each pair persists one winner, one conflict, and one operation. Lock errors fail the check.
- Simultaneous matching retries share one command and intent. Changed input under the same key fails, including after reopening the database.
- A stored conflict stays a conflict after the original blocker is removed.
- A failure while recording calendar intent rolls back the command and reservation too.
- Direct conflicting claim insertion and interval updates fail. Composite foreign keys reject mismatched organizers.
- Persisted old/candidate reservations block both ranges while leaving the gap bookable after connection reopening.

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
