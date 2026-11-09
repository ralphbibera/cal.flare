# Bounded product lifecycle models

These models describe selected upstream Cal.diy `e8afecd163cd3a0a3ff279bd4721aa7f073c4685` transitions.
They document bounded upstream transitions. They do not establish full-product correctness or observed Cal.flare parity.
Models ran in scratch outside the repository with synthetic states only.
No application implementation, private data, credentials or port-only tests changed.

## Results

Observed on November 4, 2026 with Java 17 and TLC 1.7.4.
The authoring-time Kitchen `statechart` runner used one TLC worker, no symmetry and no state constraint. No runner is added to the repository.
All states are finite by construction.

| Config | Bound | States | Steps | Checked invariants |
| --- | --- | --- | --- | --- |
| [BookingLifecycle-free.cfg](BookingLifecycle-free.cfg) | One event, one current row, at most one replacement, zero price, no approval. | 69 | 179 | `TypeOK`, `PaymentPair`, `RescheduleRetainsOldCancellation`, `NoOldProviderDeletion`. |
| [BookingLifecycle-approval.cfg](BookingLifecycle-approval.cfg) | Same row bound, zero price, approval required. | 99 | 266 | Same four. |
| [BookingLifecycle-payment.cfg](BookingLifecycle-payment.cfg) | Same row bound, positive-price category, no approval. | 177 | 486 | Same four. |
| [BookingLifecycle-approval-payment.cfg](BookingLifecycle-approval-payment.cfg) | Same row bound, positive-price category, approval required. | 167 | 467 | Same four. |
| [SeatAllocation.cfg](SeatAllocation.cfg) | Two distinct attendees, one remaining seat, serialized booking-row transaction. | 9 | 10 | `TypeOK`, `CapacityPreserved`, `NoPartialSeat`, `ExclusiveLock`. |
| [TaskDelivery.cfg](TaskDelivery.cfg) | One due internal `sendWebhook` task, one processor, three attempts, no crash. | 22 | 28 | `TypeOK`, `SuccessRecordedAfterAttempt`, `ExhaustedHasNoFurtherAttempt`. |

Each run completed with those rules holding. Generated reports also list `NoDeadlock`.
The lifecycle permits stuttering in every state; seat/task models stutter at completion or exhaustion.
That deadlock result proves no eventual delivery, timeout, fairness, or progress property.
No temporal liveness property was checked.
The source-to-action bindings were rechecked at this pin. TLA/config/view inputs and generated outputs remain unchanged: the updated confirmation-mail and app-status effects are outside their state variables and invariants.
The retained results do not verify notification dispatch, suppression, recipients, delivery, or warning aggregation. Those effects belong to the source tables, handwritten flow, inherited assertions, and implementation replay.

| Artifact | Meaning |
| --- | --- |
| [Free chart](booking-free/chart.mmd), [report](booking-free/report.md) | Generated graph of zero-price status changes. |
| [Approval chart](booking-approval/chart.mmd), [report](booking-approval/report.md) | Generated graph with manual approval. |
| [Payment chart](booking-payment/chart.mmd), [report](booking-payment/report.md) | Generated graph with supported receipt and unpaid host confirmation. |
| [Approval/payment chart](booking-approval-payment/chart.mmd), [report](booking-approval-payment/report.md) | Generated graph with separate paid and accepted states. |
| [Seat chart](seat-allocation/chart.mmd), [report](seat-allocation/report.md) | Generated graph of contention for one seat. |
| [Task chart](task-delivery/chart.mmd), [report](task-delivery/report.md) | Generated graph includes a resolved HTTP 500 marked task-successful. |
| [Auth chart](auth-session.mmd) | Handwritten source summary of login/session, 2FA settings, and reset. Not TLC checked. |
| [Booking flow](booking-flow.mmd) | Handwritten source summary of lifecycle and seat branches. Not TLC checked. |
| [Calendar/provider chart](calendar-provider.mmd) | Independent credential, read/cache, provider-operation and subscription machines. Not TLC checked. |

The generated booking view merges states with the same current status and paid flag.
It hides provider-call phase, replacement identity, and all steps that stay in one chart label.
Its report gives the count of omitted same-label steps. No extra `step()` filter hides arrows.
The handwritten booking chart and source tables preserve ordering omitted by this DB-status view.
The payment graphs retain 27 arrows because late status changes remain distinct.
They are graphs of the bounded core handlers, not a promise that every UI or API wrapper exposes every edge.

## Source and atomic boundaries

| Model/action | Pinned source and represented boundary |
| --- | --- |
| `Persist` | [createBooking.ts:183–220][createBooking]. One successful nested booking write after validation. Missing rows, rejected validation, dry run and ID generation are outside the model. |
| Initial accepted/pending choice | [getRequiresConfirmationFlags.ts:13–93][confirmationFlags]. `Price` is the zero/positive category. `RequiresConfirmation` is fixed effective configuration with free-email override disabled and no moving threshold. Owner-reschedule override is outside the model. |
| `ConfirmUnpaid` | [confirm.handler.ts:179–197][confirm]. A payment record is assumed for positive-price cases. The source sets accepted and returns while unpaid, before provider work. |
| `BeginConfirmation`, `ProviderReturns`, `SaveConfirmation` | [handleConfirmation effects][handleConfirm], [accepted writes][handleConfirmWrites]. Provider result and DB acceptance are separate model steps. All failed results still permit acceptance. Source attempts notifications, subject to `emailsEnabled` and recipient suppression, between these steps and catches mail failure. The model has one abstract provider outcome and omits notification/reference data. |
| `PaymentCommit` | [handlePaymentSuccess.ts:54–115][paymentSuccess]. One source array transaction sets payment success and paid flag together. Fixed confirmation requirement preserves prior status or selects accepted. Receipt signature, price and policy validation are assumed already passed at a supported webhook. |
| `BeginAcceptedReceipt`, `AcceptedPaymentCommit` | [handlePaymentSuccess.ts:64–115][paymentSuccess]. For an already-accepted booking, provider create returns before the payment transaction. For a previously unconfirmed receipt, the source transaction precedes `handleConfirmation` at lines 191–202. |
| `Reject` | [confirm.handler.ts:413–430][confirmReject]. Model represents status write only. Authorization and successful/no-op refund preconditions are assumed. Refund, rejection reason, notifications and handler failure are omitted. The core handler guards accepted status, not every other lifecycle status. |
| `CancellationWebhookAttempt`, `CancelDB`, `DeleteProviderReturns` | [handleCancelBooking.ts:327–524][cancelEffects]. Source webhook attempt precedes cancellation DB write. Provider cleanup follows DB cancellation and can fail softly. Guard success, reason, date and non-seat context are assumed. Model abstracts the later refund, references, job and mail effects. |
| `RescheduleDB` | [createBooking transaction][createBooking], [replacement data][createBookingReschedule]. One successful source transaction cancels original non-seat row and creates replacement, carrying paid state. Model excludes a second replacement and keeps original unchanged afterward. |
| `CancelOld` and `NoOldProviderDeletion` | [handleCancelBooking.ts:129–139][cancel]. An unchanged cancelled original fails before provider deletion. The model excludes another actor first reconfirming or modifying that original. It does not prove arbitrary concurrent cancel/reschedule ordering. |
| Seat `Acquire`, `Add`, `Full` | [createNewSeat.ts:41–114][seats]. PostgreSQL `FOR UPDATE` remains held through fresh count and nested attendee/seat write. `Add` is the whole committed transaction. It counts distinct requests for an existing booking with positive capacity. It assumes FK consistency and normal transaction behavior. |
| Task `FetchDue` | [TaskRepository:21–74][taskRepo]. Model starts due, unsucceeded and under attempt limit. No lease is inferred. One processor is a model bound, not a source guarantee. |
| `Http500Resolves`, `RecordSuccess` | [sendPayload.ts:301–326][sendPayload], [sendWebook.ts:20–29][sendWebhookTask], [TaskProcessor:23–35][taskProcessor]. A resolved HTTP response does not reject this handler; processor records success. This does not describe every webhook consumer. |
| `TransportRejects`, `RecordRetry` | [TaskProcessor:23–35][taskProcessor], [TaskRepository:110–149][taskRepo]. A rejected handler updates attempts and schedule/error bookkeeping. Date is abstracted as eligible again. |

The source model does not create a guarantee of no overlapping non-seat bookings, all accepted bookings paid, or accepted bookings having successful provider events.
The generated graphs contain accepted/unpaid and failed-provider-compatible states.
The task graph deliberately does not assert receiver success whenever the task succeeds.

The auth chart's OAuth 2FA redirect is not evidence that passwordless completion works.
[Login view:113–170][loginView] omits password for `totpEmail`, while the credential verifier still requires password verification.
The behavior contract retains this source mismatch and requires account-specific replay.

The provider chart contains independent machines. It does not order every provider call after every DB write.
Regular booking persists before provider work. Confirmation creates provider event before its accepted write.
Both fresh default-accepted creation and confirmation attempt guarded notifications even when every returned integration result fails. Fresh creation dispatches after the initial DB write; confirmation dispatches before its accepted write. A thrown provider call is distinct from returned failed results and can abort before notification dispatch. [fresh booking effects][regularProvider], [confirmation effects][handleConfirm]
Already-accepted payment receipt creates provider event before payment transaction.
Non-seat reschedule transaction precedes provider update. Cancellation attempts webhook, saves cancelled status, then cleans providers.
Those caller-specific orders are part of acceptance, even when the chart merges or omits internal stages.

## Negative controls

Two intentional mutations ran only on scratch models. Both failed the expected rule.
They are nonvacuity checks for these abstractions, not observed defects in pinned product code.
No failing source-code path is claimed by either control.

| Mutation | Observed shortest counterexample | Artifacts |
| --- | --- | --- |
| Remove ` /\ Cardinality(holders) < Capacity` from seat `Add`. | `CapacityPreserved` fails after four steps. A locks, commits seat, B locks, commits second seat despite capacity one. | [Chart](negative-controls/seat-capacity/chart.mmd), [report](negative-controls/seat-capacity/report.md). |
| Remove ` /\ oldStatus # "cancelled"` from `CancelOld`. | `NoOldProviderDeletion` fails after three steps. Submit, reschedule to cancel original, cancel original and delete provider event. | [Chart](negative-controls/cancel-original/chart.mmd), [report](negative-controls/cancel-original/report.md). |

Control views preserve failing states and every step on the failing path.
Seat view names over-capacity explicitly. Cancellation control view separates unchanged original cancellation from provider deletion.
The unmutated six configurations passed after the source model was finalized; controls do not change those checked files.
These controls test two guarded rules. They do not demonstrate sensitivity of every type or bookkeeping invariant to an independently mutated product implementation.

## Reproduce invariant checks

The retained `.tla` files and `.cfg` files are declarative specifications, not application scripts or a new test runner.
Java 17 and TLC 1.7.4 produced the recorded results. Obtain the pinned `tla2tools.jar` from the [TLA+ release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).
Its SHA256 is `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
Copy the model and chosen configuration into a fresh scratch directory outside the repository, then run TLC with one worker:

```sh
java -cp /path/to/tla2tools.jar tlc2.TLC -workers 1 -config BookingLifecycle-free.cfg BookingLifecycle
```

Use each retained booking profile configuration, then `SeatAllocation.cfg` with `SeatAllocation` and `TaskDelivery.cfg` with `TaskDelivery`.
Expected baseline exit is zero with the listed invariants holding. Stuttering does not prove eventual progress.
The Mermaid diagrams are static documentation. No rendering script or new repository runner is included.
The negative-control table identifies exact scratch-only changes and expected invariant failures. No mutant replaces a baseline specification.

## Details outside these bounds

| Detail excluded from model | Required implementation evidence |
| --- | --- |
| Auth and 2FA cryptography, backup-code concurrency, OAuth linking, cookie/JWT/session cache and reset token expiry. | The `D_AUTH` inherited suites and real-route differential replay, including failed and post-write branches. Handwritten chart is source documentation only. |
| Actual forms, copy, layout, keyboard, theme, locale and time-zone formatting. | Real UI and response observations against the pin for each moved route and configuration. |
| Availability algorithm, DST, constraints, watchlist, round robin, managed/dynamic/collective/recurring events, private links, travel and holidays. | Named availability and booking branch obligations in the behavior contract, plus inherited suites and operational replay. |
| Multiple simultaneous booking mutations, arbitrary original-row changes, multiple reschedules and bookings, stale reads, source cancellation/confirmation races. | Actual service/DB replay with synthetic concurrent requests and controlled provider outcomes. No universal race safety is proved here. |
| Non-seat booking exclusion, D1 transaction translation and FK/default/null/collation behavior. | Real workerd/D1 operations matching pinned PostgreSQL relation state and failure atomicity. Seat model assumes the existing lock/transaction semantics and cannot prove their D1 replacement. |
| Receipt idempotency, signature checks, provider-specific response codes, HOLD, refunds, amount/currency/addon math, Stripe community stubs and changing confirmation thresholds/free-email overrides. | Per-provider raw HTTP, DB and sandbox evidence in `D_PAYMENTS`. |
| Multiple providers, external timeouts or partial success, credentials/delegation, host changes, reference data, notification dispatch/suppression/delivery, app-status counts/errors/warnings, mail recipients/templates and webhook signing. | Per-caller ordering and partial-state observations in `D_BOOKING`, `D_APPS`, and `D_JOBS`, including inherited all-failed integration email and aggregation assertions. No mail or app-status invariant exists in these models. |
| Task crashes, overlapping processors, duplicate sends, bookkeeping failure, unknown handler/import rejection, actual timing and Trigger retries. | Real tasker/cron/queue replay and receiver records with exact runner/config. Task model bounds one processor and successful bookkeeping. |
| V2 auth/permissions/roles/throttling, endpoint version and DTO branches, OAuth/Redis/Bull semantics, embeds, documentation and shell. | The independent domain obligations and complete route/source inventories. These are outside TLC verification. |

A source edit affecting a modeled boundary requires rechecking the source-to-action mapping before rerunning the model.
A green stale abstraction is not acceptance evidence.

[createBooking]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleNewBooking/createBooking.ts#L96-L220
[confirmationFlags]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleNewBooking/getRequiresConfirmationFlags.ts#L13-L93
[confirm]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/trpc/server/routers/viewer/bookings/confirm.handler.ts#L161-L197
[handleConfirm]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleConfirmation.ts#L76-L122
[paymentSuccess]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/app-store/_utils/payments/handlePaymentSuccess.ts#L35-L217
[confirmReject]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/trpc/server/routers/viewer/bookings/confirm.handler.ts#L413-L479
[cancelEffects]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleCancelBooking.ts#L308-L524
[createBookingReschedule]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleNewBooking/createBooking.ts#L228-L263
[cancel]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleCancelBooking.ts#L108-L188
[seats]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleSeats/create/createNewSeat.ts#L41-L114
[taskRepo]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/tasker/repository.ts#L21-L212
[sendPayload]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/webhooks/lib/sendPayload.ts#L296-L326
[sendWebhookTask]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/tasker/tasks/sendWebook.ts#L20-L29
[taskProcessor]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/tasker/task-processor.ts#L10-L40
[loginView]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/apps/web/modules/auth/login-view.tsx#L113-L170

[handleConfirmWrites]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/handleConfirmation.ts#L167-L261

[regularProvider]: https://github.com/calcom/cal.diy/blob/e8afecd163cd3a0a3ff279bd4721aa7f073c4685/packages/features/bookings/lib/service/RegularBookingService.ts#L2050-L2184
