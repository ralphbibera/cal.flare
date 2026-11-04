# SeatAllocation

TLC reached 10 states and 13 steps. The chart draws 6 states and 5 arrows.
The chart does not draw 3 steps that stay in one chart state.

## CapacityPreserved breaks
The shortest path has 4 steps:
0. Both requests wait
1. one request locks booking row: One request owns booking row lock
2. fresh capacity check commits attendee and seat: One seat committed
3. one request locks booking row: Remaining request checks full booking
4. fresh capacity check commits attendee and seat: Two seats committed despite capacity one

## Rules that hold
TypeOK, NoPartialSeat, ExclusiveLock, NoDeadlock
