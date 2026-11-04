# BookingLifecycle

TLC reached 106 states and 344 steps. The chart draws 8 states and 17 arrows.
The chart does not draw 275 steps that stay in one chart state.

## NoOldProviderDeletion breaks
The shortest path has 3 steps:
0. No booking
1. booker submits valid request: accepted, unpaid
2. reschedule transaction cancels original and creates replacement: accepted, unpaid, original cancelled
3. attempt to cancel original: Cancelled original deletes provider event

## Rules that hold
TypeOK, PaymentPair, RescheduleRetainsOldCancellation, NoDeadlock
