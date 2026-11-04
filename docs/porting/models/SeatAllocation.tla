------------------------- MODULE SeatAllocation -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Capacity
Actors == {"A", "B"}
VARIABLES holders, lock, phase, rejected
vars == <<holders, lock, phase, rejected>>
Init == /\ holders = {} /\ lock = "none"
        /\ phase = [a \in Actors |-> "waiting"] /\ rejected = {}
Acquire(a) == /\ phase[a] = "waiting" /\ lock = "none"
              /\ lock' = a /\ phase' = [phase EXCEPT ![a] = "locked"]
              /\ UNCHANGED <<holders, rejected>>
Add(a) == /\ phase[a] = "locked" /\ lock = a /\ Cardinality(holders) < Capacity
          /\ holders' = holders \cup {a} /\ phase' = [phase EXCEPT ![a] = "done"]
          /\ lock' = "none" /\ UNCHANGED rejected
Full(a) == /\ phase[a] = "locked" /\ lock = a /\ Cardinality(holders) >= Capacity
           /\ rejected' = rejected \cup {a} /\ phase' = [phase EXCEPT ![a] = "done"]
           /\ lock' = "none" /\ UNCHANGED holders
Idle == (\A a \in Actors : phase[a] = "done") /\ UNCHANGED vars
Next == (\E a \in Actors : Acquire(a) \/ Add(a) \/ Full(a)) \/ Idle
TypeOK == /\ holders \subseteq Actors /\ rejected \subseteq Actors
          /\ lock \in Actors \cup {"none"} /\ phase \in [Actors -> {"waiting", "locked", "done"}]
CapacityPreserved == Cardinality(holders) <= Capacity
NoPartialSeat == holders \cap rejected = {}
ExclusiveLock == \A a \in Actors : phase[a] = "locked" => lock = a
Spec == Init /\ [][Next]_vars
=============================================================================
