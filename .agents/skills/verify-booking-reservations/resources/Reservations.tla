-------------------------- MODULE Reservations --------------------------
EXTENDS Integers, FiniteSets
CONSTANTS AdmissionGuard, ReservationGuard
VARIABLE rows
vars == <<rows>>
Bookings == {1, 2}
Intervals == {1, 2, 3}
Start == [i \in Intervals |-> CASE i = 1 -> 0 [] i = 2 -> 5 [] OTHER -> 10]
End == [i \in Intervals |-> Start[i] + 10]
Overlap(i, j) == Start[i] < End[j] /\ Start[j] < End[i]
Holds(b) == {rows[b].current, rows[b].candidate} \ {0}
Clear(b, i) == \A other \in Bookings \ {b} :
                 \A held \in Holds(other) : ~Overlap(i, held)
NoOverlap == \A b \in Bookings : \A other \in Bookings \ {b} :
               \A i \in Holds(b) : \A j \in Holds(other) : ~Overlap(i, j)
Init == rows = [b \in Bookings |->
  [event |-> b, state |-> "absent", version |-> 0, current |-> 0,
   candidate |-> 0, action |-> "none", execution |-> "done",
   nonce |-> 0, dispatch |-> 0, generation |-> 0]]

\* One INSERT in BookingService.admit's batch, including ALL booking_admit effects.
\* Rejected commands and exact replays have no effect on this projection.
Admit(b, action, i) ==
  /\ rows[b].execution = "done"
  /\ CASE action = "create" -> rows[b].state = "absent"
       [] action = "reschedule" -> rows[b].state = "active" /\ rows[b].version = 1
       [] OTHER -> rows[b].state = "active" /\ rows[b].version \in {1, 2}
  /\ (action = "cancel" \/ ~AdmissionGuard \/ Clear(b, i))
  /\ (action = "cancel" \/ ~ReservationGuard \/ Clear(b, i))
  /\ rows' = [rows EXCEPT ![b] =
       [@ EXCEPT !.state = IF action = "create" THEN "unconfirmed" ELSE @,
         !.version = @ + 1, !.candidate = IF action = "cancel" THEN 0 ELSE i,
         !.action = action, !.execution = "queued", !.nonce = 0,
         !.dispatch = 0, !.generation = 0]]

\* process's lease UPDATE + SELECT batch; time may pass before any takeover.
Claim(b) ==
  /\ rows[b].execution \in {"queued", "sent"}
  /\ rows[b].generation < 2
  /\ rows' = [rows EXCEPT ![b].generation = @ + 1,
                            ![b].nonce = rows[b].generation + 1]

\* run's sent UPDATE is separate from admission, provider IO, and finish.
Send(b, version, nonce) ==
  /\ rows[b].version = version /\ rows[b].nonce = nonce /\ nonce # 0
  /\ rows[b].execution \in {"queued", "sent"}
  /\ (rows[b].action # "create" \/ rows[b].execution = "queued")
  /\ rows' = [rows EXCEPT ![b].execution = "sent", ![b].dispatch = nonce]

\* A definitive create rejection may reset using dispatch_nonce after takeover.
RejectedInsert(b, version, dispatch) ==
  /\ rows[b].version = version /\ rows[b].action = "create"
  /\ rows[b].execution = "sent" /\ rows[b].dispatch = dispatch /\ dispatch # 0
  /\ rows' = [rows EXCEPT ![b].execution = "queued", ![b].nonce = 0,
                            ![b].dispatch = 0]

\* finish's single UPDATE batch and booking_finish trigger are ONE transaction.
\* Noncancel success supplies an etag; stale command versions/nonces cannot act.
Finish(b, version, nonce) ==
  /\ rows[b].version = version /\ rows[b].nonce = nonce /\ nonce # 0
  /\ rows[b].execution = "sent"
  /\ IF rows[b].action = "cancel" THEN TRUE
     ELSE (~ReservationGuard \/ Clear(b, rows[b].candidate))
  /\ rows' = [rows EXCEPT ![b] =
       [@ EXCEPT !.current = IF rows[b].action = "cancel" THEN 0 ELSE rows[b].candidate,
         !.candidate = 0, !.execution = "done",
         !.state = IF rows[b].action = "cancel" THEN "cancelled" ELSE "active"]]

\* Delays, crashes, rejected/stale/busy calls, reads, attention, and replay.
Wait == UNCHANGED vars
Next == (\E b \in Bookings, i \in Intervals, a \in {"create", "reschedule", "cancel"} : Admit(b, a, i))
     \/ (\E b \in Bookings : Claim(b))
     \/ (\E b \in Bookings, v \in 1..3, n \in 1..2 : Send(b, v, n))
     \/ (\E b \in Bookings, v \in 1..3, n \in 1..2 : RejectedInsert(b, v, n))
     \/ (\E b \in Bookings, v \in 1..3, n \in 1..2 : Finish(b, v, n))
     \/ Wait
Spec == Init /\ [][Next]_vars
=============================================================================
