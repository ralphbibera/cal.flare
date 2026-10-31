---
name: verify-booking-reservations
description: Check organizer-wide booking reservation safety after changes to admission, current and candidate holds, delivery finalization, retries, or their SQL triggers. Runs a bounded TLA+ model and a real SQLite witness with source drift detection.
---

# Verify booking reservations

Property: Two different bookings never hold overlapping organizer UTC time, across both `current` and `candidate` reservations.

Harm: A broken hold lets the organizer accept two appointments for the same time while a create, move, or cancellation remains unresolved.

## Check a change

1. Read this skill, `resources/Reservations.tla`, and every covered source diff **before trusting a pass**:

   ```sh
   git diff dc2b3f6f6ac50fa740636952af0df09db3333b0a -- apps/flare/migrations apps/flare/src/server/bookings.ts apps/flare/src/server/booking-delivery.ts apps/flare/src/server/booking-availability.ts apps/flare/src/server/booking-model.ts apps/flare/src/server/settings.ts apps/flare/src/domain/settings.ts apps/flare/src/domain/scheduling.ts
   ```

   Also inspect untracked migrations and covered source files. The wrapper refuses covered drift, including new migrations. A refusal means the mapping needs review, not that the property is broken. The SQL witness runs first so an unsafe SQL change can report its actual overlap.
2. From the checkout root, run the single check command:

   ```sh
   python3 .agents/skills/verify-booking-reservations/resources/check.py
   ```

   Requires Python 3 with SQLite JSON operators, Java 11+, and `gh` for the first download. No package install or server is needed. It downloads TLA+ Tools release v1.7.4 (TLC 2.19) to ignored `.verification/formal/tla2tools.jar`, checks SHA256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`, executes real migration/service SQL against temporary SQLite, and runs TLC with one worker. Temporary databases and TLC state are removed. Exit 0 requires both checks and the drift gate to pass. Other exits need diagnosis; never treat a tool failure as a finding or a pass.
3. Read every TLA+ result with Kitchen `/statechart`. Follow that skill's current instructions in a scratch directory, using this model and config and the checked jar. Do not copy machine-specific statechart commands into this skill. Use the action map below to explain the shortest counterexample in booking terms. Above its chart budget, statechart reports counts and bug paths without a full passing chart.
4. If a counterexample appears, replay each transaction against the actual SQL. A model trace alone is not a product bug. Preserve real findings; do not weaken `NoOverlap`, hide interleavings, or add an overlap assumption to get a pass. Do not change product code without task authorization.

## Keep the model in sync

Sync commit: `dc2b3f6f6ac50fa740636952af0df09db3333b0a`

This is a manually reviewed mapping, not an automatic proof of SQL or TypeScript. The drift gate compares all migrations and the seven source files below against the sync commit. The command shown above uses that commit too. Update both references only after semantic review of the covered diffs, an appropriate model update, and successful positive and negative controls. For uncommitted covered changes, report drift and provisional evidence, then advance the sync commit only after an authorized commit exists. Never bypass the gate by updating the commit first. Use `/maintain-formal-verification-skill` when later changes have skipped this review.

| Source owner | Mapping and review obligation |
| --- | --- |
| `apps/flare/migrations/0003_bookings.sql`: `booking_reservation`, `booking_reservation_no_overlap`, `booking_reservation_immutable`, `booking_finish`, `booking_one_pending` | `Holds` includes current and candidate. Strict inequalities implement half-open ranges. Only another booking conflicts; the same booking's two roles may overlap. `Finish` replaces roles inside one terminal UPDATE transaction, never as separately interleavable deletes and inserts. Inserts retain the second overlap defense. |
| `apps/flare/migrations/0005_events.sql`: `booking_event_identity`; `0006_event_lifecycle.sql`; `0007_availability_schedules.sql`: current `booking_admit` and `booking_command_identity` | `Admit` is the complete command INSERT transaction with trigger effects. Current admission checks event identity, busy, expected version, active state, settings/schedule provenance, removal, precondition, then owner-global overlap. Neither overlap guard filters by event. The immutable event in `rows` is fixed per booking. Earlier admission trigger definitions are superseded by 0007. Review all later migrations for replacement owners. |
| `apps/flare/src/server/bookings.ts`: `BookingService.admit`, `create`, `changeBooking`, `replay`, `retryBooking` | Admission batch is one atomic step. Intervals represent **occupied** UTC milliseconds after before/after buffers, not raw appointment times or wall-clock dates. Pending holds remain through retry. Exact request replay and refused commands do not alter reservations. |
| `apps/flare/src/server/booking-delivery.ts`: `process`, `run`, `attention`, `finish` | `Claim`, `Send`, `RejectedInsert`, and `Finish` are separate transactions. Provider IO is between them. Lease takeover changes nonce; dispatch nonce independently fences definitive create rejection. Finalization requires the same pending command/version and worker nonce, accepted outcome, done execution, and a non-null result etag unless cancelling. No stale worker gets a successful `Finish`. |
| `apps/flare/src/server/booking-availability.ts`: `condition`, `slots`; `booking-model.ts`: `Command`, `Booking`, snapshots and parsers | Local reservation reads are global across events and exclude only the same booking. Read/check/insert is not modeled as atomic: only the command INSERT and its triggers are. Snapshot/interval validation and command identity must remain compatible with the projection. |
| `apps/flare/src/server/settings.ts`: `getAdmissionContext`, policy getters; `apps/flare/src/domain/settings.ts`: policy parsing and notice; `apps/flare/src/domain/scheduling.ts`: `availableSlots` | Policy refusals (disabled actions, ended restrictions, attendee notice, availability, removed events, settings/schedule changes) project to `Wait`. The model explores the admitted branch whenever permitted by booking state, so it overapproximates these gates. It does not verify their correctness or authorize changing them. Cancellation still needs policy/provenance acceptance in real code. |

`parseOptionalEventPolicy` and `parseDatedOverrides` retain the existing validation and canonical settings order. They remain within the policy-gate projection above and introduce no reservation transaction or overlap assumption.

At the sync commit, `utcWorkingIntervals`, `subtractBusyIntervals`, and `freeWorkingIntervals` separate availability planning without changing this policy-gate projection. The admission and finalization transactions, occupied interval calculation, and both overlap guards remain unchanged.

## Understand the bound

TLC is used because the question concerns the order of durable steps. It explores every reachable ordering in this finite model without fairness assumptions:

- Two bookings, assigned to two distinct event IDs under the current single organizer. This exercises cross-event conflicts; identical-event conflicts use the same global predicate. No multi-organizer isolation claim is made.
- Three occupied interval choices: `[0,10)`, `[5,15)`, `[10,20)`. They exercise equality, overlap, adjacency, and simultaneous old/new holds. Values are normalized representatives of validated occupied UTC intervals, not literal API timestamps. Other lengths, DST calculations, buffer arithmetic, and integer extremes are outside the bound.
- At most one accepted create, one accepted move, and one accepted cancel per booking. Cancel may follow create directly. Versions 1–3 identify immutable accepted commands; `execution != done` is the pending ID in this projection. Completed commands are not reused. This is not an arbitrary-command-count proof.
- Two worker lease generations per accepted command. Claim may occur after any delay, including after a send. `Send` and `Finish` enumerate command versions and nonces and only matching ones act. The model omits nonce bytes, wall-clock due/lease values, attempts, payloads, and etag strings. Successful noncancel finalization assumes a supplied etag; provider success/reconciliation is nondeterministic. No claim about provider correctness follows.
- Delays, crash/restart, failed guards, stale workers, exact retries, attention/backoff, policy rejection, and reads may stutter arbitrarily. A sent create cannot dispatch again until definitive rejection resets it using its dispatch nonce. The model does not promise eventual delivery, cleanup, progress, network behavior, infinite bounds, D1 runtime semantics, or SQL bytecode equivalence.

`Admit` combines the admission conflict clause and the reservation INSERT guard because they execute in the same actual transaction. Removing either alone still preserves this property. `Finish` combines the terminal UPDATE and all `booking_finish` effects for the same reason. No provider call or separate DB statement is hidden inside either atomic step.

The SQLite witness reuses the setup and transition cases from `apps/flare/scripts/booking-storage.test.ts`. It executes current migration files and extracts the actual `BookingService.admit` and `BookingDelivery.finish` SQL, rather than rewriting those statements. It checks overlap before checking outcomes, both held ranges during queued/sent moves, crash/reopen, adjacency, cancellation release, and exact replay. It is a local SQL trace, not exhaustive real-code verification, D1 parity, concurrent HTTP execution, or a provider test. If extraction stops matching after refactoring, review and update it instead of substituting copied SQL.

## Confirm that the check can fail

Use only an owned scratch copy or the task's isolated checkout. Restore every mutation before handoff. Do not mutate another checkout or keep mutant files in this skill.

1. In a scratch model/config, set `AdmissionGuard` and `ReservationGuard` to `FALSE`. TLC must report `NoOverlap` and exit nonzero. Setting only one false must still pass. Read results with `/statechart`.
2. In scratch **real migration source**, remove the overlap conflict clause from 0007 `booking_admit` and remove `booking_reservation_no_overlap` from 0003. Run the generated command. It must fail in the SQL witness with two different booking reservations actually overlapping, before the drift gate or TLC. Removing only the admission clause should still cause `reservation_overlap` and transactional rollback, not an accepted overlapping booking.
3. Restore source and model/config, inspect the covered diffs, and rerun the single command. Also mutate only a covered source comment and confirm the command refuses source drift. A passing hand model must never conceal an unreviewed source change.

The broken-guards shortest trace is: accept event A's create holding `[0,10)`; accept event B's create holding `[0,10)` while A is queued. Both different bookings now hold the same organizer time. The real SQL witness uses `[0,10)` then `[5,15)` for the same harm. Successful baseline verification covers only the stated model and concrete SQL witness.
