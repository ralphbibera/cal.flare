# Develop Cal.flare locally

The repository root runs the focused Astro/React/Workers port in this directory.
The inherited Cal.diy packages are outside the active workspace graph.
The root MIT license and Cal.com attribution continue to apply.
For the ordered operator procedure, use [Configure and run Cal.flare](SETUP.md).
It covers Google access, Workers with static assets, D1 deployment, deployed acceptance, and recovery.
This page is the development and implementation reference.

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
The [production procedure](SETUP.md#deploy-to-cloudflare-workers) builds after source configuration,
then deploys with `yarn workspace @calflare/web exec wrangler deploy --config dist/server/wrangler.json`.
Local preview and mocked-provider checks do not establish production readiness.

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
booking lifecycle APIs, and scheduled recovery. The current model has one organizer and multiple events,
with selected conflict calendars and primary-calendar event operations. Broader account and feature parity remain migration work.
Generated Wrangler types and local state are ignored. Checked-in Wrangler configuration has no production database UUID or variables.
Image transformation and Astro's default session storage are disabled.
Production resource configuration, deployed execution, live Google delivery, and measured
Workers and D1 usage require separate verification and deployment authorization.

### Capture the pinned public page

For optional native Next.js/PostgreSQL reference captures and pixel-proof limits, see
[Capture the pinned public page](../../docs/porting/cloudflare-astro.md#capture-the-pinned-public-page)
in the porting guide. The default verification path needs no native reference checkout or database.

## Owner configuration

Open `/` to sign in with the Google account configured for this installation.
The private organizer page links to the public event preview. Sign-out revokes the current
session and returns to the sign-in page. These entry forms work without browser JavaScript.
Select an event with `/?eventId=<stable-id>`, or use **Create event** to open `/?create=1`.
Creation replaces the details editor and shows booking rules after the event exists.
New events use app defaults for their rules. Each event keeps its own details and rules.
The owner API returns each event's stable ID, definition, and `listed` or `hidden` lifecycle.
`POST /api/owner/events/:id/duplicate` accepts only title, slug, description, and durationMinutes.
It copies saved rules, policies, location, and visibility under a new ID.
`PATCH /api/owner/events/:id/visibility` accepts only `{ "hidden": boolean }`.
Hidden events remain directly bookable. `DELETE /api/owner/events/:id` accepts no body and retains a permanent tombstone.
Removal blocks fresh bookings and rescheduling while retaining history, occupancy, replay, and accepted-command recovery.
Cancellation still follows the saved current policy. Removed slugs cannot be reused.
The owner page offers these lifecycle controls. **Duplicate event** opens `/?duplicate=<stable-id>`
with one four-field editor. It uses the saved source, preserves its location and rules, and opens the
new event after a valid acknowledgment. A collision keeps the draft. An uncertain create or duplicate
locks submission and offers a GET-only event refresh with explicit candidate selection.
Visibility changes require Save. Removal names the current saved event and requires inline confirmation.
An unacknowledged removal can be retried safely against the same event.
Anonymous visitors browse listed events at `/public/events`. This directory is server-rendered and
contains only public event details and the sanitized organizer name. Hidden events retain direct links.
After default removal, owner entry selects the first remaining event. With no events, entry opens creation with shared preferences and booking history.
Events resolve an explicit reusable schedule or the owner's current default. Working hours, timezone,
and dated overrides are shared only by events using that schedule. Conflict calendars remain owner-wide.
The existing hours and override editors save the resolved schedule shown for the selected event,
including duplicate-source mode. Creation and empty-event mode edit the owner's default schedule.
The named schedule manager and event-assignment controls remain pending.
An uncertain creation keeps the draft and offers **Refresh events** to inspect explicit selection candidates.
The app does not automatically repeat the creation request.
The organizer page edits the event title, URL slug, description, duration, and optional static location with browser JavaScript.
Saving these details preserves scheduling rules and booking policies. The private page also edits
working hours, dated overrides and booking rules. These are functional checkpoints; upstream editor pixel parity remains open.

The private home has a **Conflict calendars** control with labelled checkboxes and explicit **Save**,
**Clear selection**, and **Reset to primary** actions. Loading calendars runs independently of the
home and other editors. Failed loads offer reload and Google reconnection. Saved IDs missing from
discovery stay visible as unavailable until explicitly removed. Reloading discovery preserves drafts;
failed or unacknowledged saves retain them for explicit retry. Clear selection edits the draft and
requires Save. Reset immediately restores the primary-only default. Both empty saves and reset
remain available after discovery fails. Names and IDs render as literal text on the private page.
Owner-session-authenticated `GET /api/owner/conflict-calendars` returns
`{ calendars: [{ id, name, primary }], conflictCalendarIds }` with
no-store JSON. Discovery includes hidden subscriptions and readable/free-busy-only calendars,
excludes deleted, holiday and contacts calendars, and preserves custom group calendar IDs.
The primary calendar is normalized to `primary`. Pagination fails without partial results on
malformed data, duplicate IDs, ambiguous primary flags, repeated cursors, more than 10 pages or
1,000 entries. Discovery does not write settings, bookings, commands, reservations or rate-limit counters.
Existing credential refresh can still persist a renewed token. Failure does not affect owner home.
New consent requests `calendar.events`, `calendar.events.freebusy` and
`calendar.calendarlist.readonly` with incremental authorization. Existing connections remain
usable for the old primary-calendar flow until the owner reauthorizes. Refresh alone cannot add
permissions. See [Google configuration and reauthorization](SETUP.md#configure-google-calendar-access).
Owner-session-authenticated, same-origin `PATCH /api/owner/conflict-calendars` accepts exactly
`{ conflictCalendarIds: string[] | null }`. Arrays replace the selection with at most 50 unique,
case-sensitive IDs sorted by code unit. Nonempty selections require complete current discovery
and may contain only its eligible IDs, with the primary calendar represented by `primary`.
Discovery failures save nothing. `null` removes the setting and restores legacy primary-only
checks. `[]` skips external conflicts while local booking reservations still block overlaps.
Full settings PUT accepts the optional array; omission resets it and null is invalid.
Selection IDs persist in private owner settings and frozen commands. Public settings, SSR,
slots and booking views omit them. Names are not persisted.
Selected primary conflicts use the existing event list. Secondaries use one free/busy request,
without event details. Missing entries, revoked access and provider failures fail availability
as a whole. Queued recovery uses its frozen selection against current busy data. Event
reads, writes and reconciliation still use the primary calendar. Local mocked-provider checks do not
establish a live Google grant or live discovery. The existing built Worker browser runner checks
default, selected, empty and reset settings, reloads, failed and malformed responses, unavailable
IDs, keyboard input and overflow at 390px and 1280px. It exercises secondary busy admission and
local holds through public confirmation using the actual Google adapter with mocked HTTP.
Native calendar-control pixel parity, live Google access and deployed behavior remain unverified.

The static-location flow accepts optional `event.location` through authenticated
`PUT /api/owner`, or `location` alongside the four event-detail fields in `PATCH /api/owner`.
Flare policy accepts strings only, trims surrounding whitespace, and limits the result to 1,000 UTF-16 units.
Internal whitespace, Unicode, and literal markup remain text. Blank strings clear the setting.
PATCH omission preserves it; full PUT omission clears it. Legacy settings retain no location member.
The address stays private before confirmation and is removed from public JSON, SSR, and hydration props.
New bookings freeze the configured address into their initial and provider snapshots. Later settings
edits, moves and retries retain that historical value. Google event requests include the literal location;
recovery requires an exact remote match when the snapshot has one. Legacy snapshots omit location
and preserve unknown provider locations on moves. Only authorized confirmed booking API/client views
expose the frozen address. Confirmed receipts, private attendee pages, and owner details show it as
literal **Where** text. Editing, blocked storage, pending, attention, and cancelled views hide that row.
The event editor validates before saving, retains failed drafts for explicit retry, and sends a blank
location to clear only future bookings. The confirmed attendee actions export the historical address
to Google, Outlook, Office, and a downloaded `booking.ics`. Legacy exports omit location entirely.
The existing built Worker browser journey checks the editor, privacy, historical facts, moves,
and actual downloads at 390px and 1280px with mocked Google. Native location pixel parity, live
calendar imports, invitation arrival, and other location types remain unverified.

Authenticated `PATCH /api/owner/schedule` accepts `{ timeZone, rules }` for the owner-default weekly
schedule. Each rule contains `weekday` (Sunday 0 through Saturday 6), `startMinute`, and
`endMinute` within that local day. Multiple nonoverlapping ranges per day are supported;
an empty rules array closes weekly availability. This update preserves event settings and
dated overrides. The private working-hours editor uses the ID-scoped weekly endpoint to add or remove ranges,
change timezone, and close weekly availability. An end time of `00:00` represents minute 1440.
Failed saves retain the draft. Full editor pixel parity remains migration work.

Authenticated `PATCH /api/owner/overrides` replaces only the owner-default schedule's dated overrides.
Send `{ overrides: [{ date: "YYYY-MM-DD", ranges: [{ startMinute, endMinute }] }] }`.
Dates and minute ranges use the organizer's schedule timezone. Empty ranges close that date;
nonempty ranges replace its weekly hours. Send `{ overrides: [] }` to restore weekly hours
for every date. Event settings, timezone and weekly rules stay unchanged. The private
date-override editor supports dated closures and replacement intervals through the ID-scoped endpoint.
Saves are explicit, and failed saves retain the draft. Full editor pixel parity remains open.

The private reusable-schedule API uses the existing owner session, same-origin mutation checks,
strict bodies, and no-store responses. `GET /api/owner/schedules` returns
`{ defaultScheduleId, schedules: [{ id, name, schedule }] }`. `POST` accepts only `{ name }` and
returns a new record with status 201. New schedules use app weekly defaults in the owner's default
timezone, with no dated overrides. They do not change assignments or the default.
`GET /api/owner/schedules/:id` returns `{ id, name, schedule }`. `PATCH` accepts only `{ name }`.
`PATCH /:id/weekly` accepts the existing weekly body, and `PATCH /:id/overrides` accepts the existing
override body. Weekly edits preserve dated overrides, including an absent override key.
Override edits preserve weekly hours and timezone.
`POST /:id/duplicate` accepts `{ name }` and copies all saved schedule fields under an independent ID.
Names need not be unique. `PATCH /:id/default` accepts `{}` and changes fallback events only.
`PATCH /api/owner/events/:id/schedule` accepts exactly `{ scheduleId: string | null }`.
Null selects owner-default fallback. Event duplication preserves the source assignment, including null.
`DELETE /api/owner/schedules/:id` accepts no body, clears explicit references to fallback, and replaces
a deleted default with the earliest surviving schedule. The database rejects deleting the final schedule.
A repeat delete of an absent valid ID succeeds. An unknown GET returns 404.
Mutations other than create and duplicate return exactly `{ saved: true }`.
Full settings PUT edits the stable default event's resolved schedule and preserves its assignment.
Public metadata, booking views, slots, and request bodies do not expose or accept schedule identity.
Accepted commands keep their frozen settings through schedule changes and deletion.

Authenticated `PATCH /api/owner/booking-rules` replaces slot spacing, buffers, minimum notice
and guest change rules. Send all six fields: `intervalMinutes`, `beforeMinutes`, `afterMinutes`,
`noticeMinutes`, `disableCancelling` and `disableRescheduling`. The last two fields require
explicit booleans. Event details and all schedule fields stay unchanged. Accepted booking
commands retain their original replay and recovery behavior after a rules change.
The private booking-rules editor saves these fields explicitly and retains drafts after failed
saves. Full editor pixel parity remains migration work.

**Limit future bookings** enables a rolling calendar-day window, initially 30 days. The owner
can save 1–365 whole days and reload the setting. This subset uses the booker's timezone,
not the organizer's schedule timezone. Today plus the configured number of civil dates is
included in full. January 1 plus 30 days permits starts through January 31. DST does not turn
the limit into elapsed 24-hour periods. Only the start is checked, so a normally available
appointment can end after the final day. Working hours, notice, buffers and occupancy still apply.
Public listing and fresh creates use the query or submitted booker timezone. Existing-booking
listing and fresh attendee/owner moves use the stored booking timezone for the window.
Listing still rounds display minutes in the query timezone. A valid availability query entirely
beyond the window returns an empty list. Stale selected times fail fresh admission.
Moves validate the exact selected interval without rounding it again in the stored timezone.
Fresh creates retain their existing grid-alignment requirement.
Disabling the checkbox removes the optional canonical `event.bookingWindowDays` key. Omission
keeps legacy settings bytes and the existing 365-day transport/admission ceiling. That ceiling
continues to apply even with a configured window. No business-day, available-day, fixed-range
or custom-calendar modes are implemented.

Booking-rules PATCH accepts optional `bookingWindowDays`. Omission preserves the stored limit,
an integer sets it, and explicit `null` removes it. Full settings PUT omission removes it.
The limit applies to future requests, without rewriting stored booking facts. Already accepted
create/move commands replay and recover with frozen admission settings, including uncertain
provider writes. Durable rejected requests retain their original outcome on replay. Recovery
still observes the existing occupancy, provider-match, lease and hard-horizon constraints.
Node/D1 coverage checks literal date boundaries, DST, serialization and admission/recovery.
The existing built Worker browser runner checks the owner control at 390px and 1280px and a
public selection through confirmation. Google is mocked. Live invitations, imports, deployed
behavior, native editor pixels and full-port completion are not established by these checks.

## Public booking

After the organizer connects Google and configures the event on the private home page,
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
focus preserved. Pending submissions cannot be dismissed. The dialog shows appointment date,
time, timezone, and duration above the fields. The timezone comes from the saved request during replay.
The pinned agreement follows closed **Add guests** and links to the Cal.com Terms and Privacy Policy
with the native Cal.diy wording. Back and Confirm use a sticky bordered footer in dialogs.
Complete attendee-form and dialog pixel parity remain open.
Above 768px, visitors can switch between month, consecutive-day week, and next-available-date columns. Columns show
two dates through 1024px and six above it, with the compact calendar in the sidebar and a
modal attendee form. The built-page verifier compares the initial main column region against
the pinned Next page at 900px and 1280px with zero different pixels. Complete column-page
and attendee-form pixel parity remain open.
`?layout=week_view` selects week view. Week shows four civil dates through 1024px and seven
above it, starting at the selected date. Its pager moves by that count, including closed dates.
Widths through 768px use month view. Week uses the existing availability query and shared
attendee dialog, with UTC selection, draft return, and saved pending-request replay.
The default built-page journey checks these flows without a Next server, including month and
year boundaries, loading and error recovery, sparse weeks, and Kolkata placement.
With the reference origin supplied, the initial week main region matches the pinned Next
page at 900px and 1280px with zero different pixels under the declared Chromium profile.
Full week-page, toolbar, and dialog pixel parity remain unverified.
Uncertain results retain that identity for a safe retry after reload. Acknowledged bookings
replace the pending attendee data with a private receipt in this tab's session storage.
Pending requests and receipts use `calflare:create:v2:<eventId>` with the event ID in each envelope.
They survive slug changes. Only the default event imports a v1 record matching the current pathname,
after saving v2 durably. Other old-path records stay untouched. Clearing an imported receipt cannot restore it again.
Optional **Additional notes** are trimmed and limited to 1,000 UTF-16 units after trimming.
Interior whitespace and literal text are preserved in the immutable provider description,
including through retries and rescheduling. Notes share the existing server retention and
provider invitation recipients. Clearing the browser draft and pending storage does not erase
server or provider records. Booking views and receipts do not return notes or the description.
**Add guests** expands optional ordered email rows after notes. Draft rows survive browsing
and dismissal. Added rows receive focus, and removing a row focuses the next row, previous row,
or Add guests. Valid addresses are lowercased; duplicate guest rows and mixed blank rows fail.
All-empty rows submit without guests. Oversized requests remain editable so rows can be removed.
Unacknowledged attempts show frozen recipients through reload and retry without editing controls.
Recipients persist with the immutable request and snapshot through replay and rescheduling.
Notes in the event description are shared with all provider invitation recipients, including guests.
Guest entry grants no management access. Local provider fixtures do not prove live invitation arrival.
The page distinguishes confirmed bookings from results needing recovery or organizer attention.
Acknowledged receipts and authorized private details share a standalone What/When/Who card.
It uses the stored booking title, full booking-zone date, start/end range, explicit timezone,
and duration derived from the stored interval. Later event title or duration edits do not change
these facts. Only the primary attendee name and email are shown.
Stored unresolved changes, unavailable change storage, and provider uncertainty suppress the
confirmed success heading and check. Loading details does not retry a provider operation.
The built Worker/D1 browser journey verifies these facts after event edits, public and private
reloads, and at 390px and 1280px. Google responses are mocked.
The optional native confirmation fixture supplies a repeatable reference baseline.
Receipt and authorized private confirmation presentation share the native frame contract at
390px and 1280px. Cards start 32px from the top with responsive vertical padding, a 10px radius,
and 32px horizontal padding. Both routes use the pinned Inter Booking face, including the
24px semibold heading. Details use 16px text with 24px line height and the native responsive
column gap. The success emblem uses the native colors and Lucide check path.
The existing management verifier checks literal geometry, computed styles, loaded font and
served font bytes after event-setting edits and canonical-fact reloads on both routes.
This is partial presentation contract convergence. Whole-card and whole-page pixel parity
remain unverified. Host identity, notes, guests, invitation narrative, signup, export layout,
and intentional private controls still differ. Missing content has no placeholder rows or heights.
Confirmed receipts and authorized private details offer **Add to calendar**, ordered Google,
Microsoft Outlook, Microsoft Office, then Other. The first three open external composers with
`noopener noreferrer`. Other downloads a local UTF-8 `text/calendar` file named `booking.ics`.
Other uses the existing calendar icon and fixed filename; native uses an Outlook-shaped icon and event-title filename.
Exports contain the stored title, UTC interval, and optional stored location, plus ICS identity, version, and export timestamp.
The stable UID survives rescheduling; a later download uses the canonical new interval and version.
Exports omit attendee fields, notes, guests, private links, access tokens, and description.
They hide during change selection, saved unresolved changes, blocked storage, provider uncertainty,
status refresh, and cancellation. Manual export does not send invitations or retry provider writes.
The existing browser journey decodes composer queries, aborts a keyboard-opened popup before external
network access, and reads actual downloaded ICS bytes at 390px and 1280px on public and private views.
It checks unchanged mock-provider write counts, event-setting edits, rescheduling, and hidden states.
The native row's order, 40px controls, brand paths, hrefs, and ICS were observed on the isolated fixture.
Its exports use current event metadata and description; this port uses only available canonical facts.
Live external import, account event creation, invitation arrival, and automatic calendar sync remain unverified.
Host identity, native location presentation parity, description, invitation-delivery copy, and signup branding remain later port work. Source-backed layout does not establish
candidate confirmation pixel parity or completion of the full port.

## Booking management

From that receipt, visitors can reschedule or cancel after confirmation.
Pending changes keep their request identity across reloads. Server-accepted changes
with uncertain provider outcomes expose status recovery instead of another mutation.
Use **Copy private booking link** to open the receipt in another browser without an account.
Anyone with this link can view or change the booking. The page removes the link fragment
after it saves access in that browser tab.
Cancellation requests accept optional `cancellationReason` text, trimmed and limited to
1,000 UTF-16 units after trimming. Blank text is omitted; interior whitespace and literal
text are preserved. The immutable command retains the reason locally through replay and
recovery. Authorized terminal booking views and the authenticated owner list return it
after cancellation completes. Google DELETE requests remain unchanged and carry no reason
body. Receipts and authorized private pages offer a three-row optional reason field during
cancellation. **Nevermind** retains the draft in the mounted component without submitting it.
**Cancel event** validates before saving a command; over-limit input stays editable.
Unresolved cancellations show the frozen saved reason read-only through reload and exact retry.
Completed cancellations show a literal, whitespace-preserving **Reason** row when present.
The existing built Worker/local D1 browser journey checks these functional flows at 390px and
1280px with mocked Google. Native intent and terminal-page pixel parity remain unverified.
This does not send a reason email or promise guest delivery.
Rescheduling accepts optional `rescheduleReason` with the same strict
trimmed 1,000 UTF-16 unit limit. Blank text is omitted. The immutable command records the
literal reason locally through replay and recovery. Authorized confirmed views and the owner
list return only the completed reschedule reason for the current booking version. A later move
without a reason or a cancellation removes that projection. Reasons do not enter provider
snapshots, calendar descriptions, exports, or Google PATCH requests. After selecting a new time,
receipts and private pages offer the native three-row **Reason for reschedule** field.
Back and reselection retain the mounted draft. Each acknowledged move clears it, so a later
move starts blank rather than resubmitting a previous completed reason. Validation runs before
command storage; padded valid text is trimmed without a DOM length cap. Pending moves show
the frozen reason read-only through malformed acknowledgments, reload, and exact retry.
Confirmed actions show a literal, whitespace-preserving **Reschedule reason** row only after
completion. Editing, blocked storage, and uncertain results hide that completed row.
The existing built Worker/local D1 browser journeys check these functional flows, blank omission,
and exports at 390px and 1280px with mocked Google and unchanged provider write counts.
Native interactive typing, submission, and reason-page pixel parity remain deferred because the
shared built Next fixture lacks the reschedule route. This flow does not send reason emails
or establish live invitation arrival.

The private home page also lists the latest 1,000 bookings, newest recorded first, with attendee
details, times in the organizer's schedule timezone, and lifecycle status. Viewing this list
does not retry provider operations. It renders without JavaScript. With JavaScript enabled,
**Retry pending operation** explicitly resumes the booking's existing durable command and
reloads its current status. A failed or lost response leaves an explicit retry available.
The home **Bookings** link opens private `/owner/bookings`. Its All, Upcoming, Past, and Canceled
filters and 25-row pages render without JavaScript. Upcoming means a noncancelled stored interval
ending after server now; Past includes the exact end boundary. Canceled includes all cancelled rows.
Classification uses the confirmed snapshot, falling back to the initial snapshot. Pending and
attention labels retain their actual lifecycle meaning. Later event edits do not rewrite intervals.
Filter and positive safe-integer `before` row cursors persist in the URL within authenticated sessions.
Changing filters resets paging. **Older bookings** continues newest-recorded-first keyset paging;
**First page** returns to the newest records. New inserts use normal keyset behavior. Invalid or duplicate
query fields are rejected after authentication. Reading pages never retries provider operations.
Owner cancellation and rescheduling are described below. Booking-list pixel parity remains migration work.

Owner home and paged-list titles open private booking details at `/owner/bookings/:id`.
Details use the stored booking facts and primary attendee. Reads never retry calendar writes.
The owner session authorizes GET and change POST at `/api/owner/bookings/:id`, without
minting attendee capabilities. Owner cancellation requires a nonblank, trimmed reason of at most
1000 UTF-16 units and an explicit destructive confirmation. Disabled and ended restrictions apply.
The existing immutable command, delivery and recovery path handles cancellation and exact replay.
Owner attempts reuse ChangeAttempts in a separate session-storage namespace, preserving attendee
attempts in the same tab. Uncertain acknowledgements keep the frozen request for explicit retry.
Pending operations retain the existing owner recovery control. **Reschedule** opens the existing
calendar with session-authorized availability. Selecting a time shows the proposed UTC range
and an optional three-row reason. Back and reselection preserve that draft. Invalid reasons
remain editable before storage or POST. A refused stale move refreshes canonical facts, then
requires fresh slot selection and explicit confirmation with a new request identity.
The API accepts the existing `reschedule` request with version, requestKey, UTC start and optional
rescheduleReason. Fresh owner moves retain disabled, cancelled, pending and ended restrictions.
Accepted commands remain replayable and explicitly recoverable after policy or time changes.
Authenticated `GET /api/owner/bookings/:id/slots?from=ISO&to=ISO&timeZone=IANA` excludes only the
stored booking and its matching provider event. Queries require unique known fields, valid ISO
instants, an IANA timezone and the existing 63-day range and 365-day horizon limits. Target notice,
schedule, overrides, buffers and conflicts still apply. Slots and moves use the stored duration
and retain the same booking ID and facts after event edits. Public booking exclusion still requires
the attendee bearer token, even with an owner cookie. Slot reads do not change bookings, commands,
reservations, settings or calendar events, and never dispatch delivery or recovery. Availability
rate-limit counters still write, and Google authentication may refresh persisted credentials.
The Worker/D1 browser journey verifies the functional owner flow with mocked Google at 390/1280.
This does not establish native interaction parity, live Google delivery or reason emails.
Fresh cancellations are refused after the booking ends. Previously accepted requests remain recoverable.
The authenticated settings API accepts optional `event.disableCancelling` and
`event.disableRescheduling` booleans; omitted flags preserve the existing enabled behavior.
Each flag refuses new requests for that action without changing accepted commands or their recovery.
Refusals use the existing HTTP 409 `invalid_slot` outcome and remain stable on replay.
Receipts and private management pages hide each disabled action after loading or refreshing
the booking. Existing saved attempts remain available for safe retry and reconciliation.
See [local configuration](SETUP.md) for the operator-owned OAuth requirements.
