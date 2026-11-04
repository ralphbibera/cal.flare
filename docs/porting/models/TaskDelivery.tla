-------------------------- MODULE TaskDelivery --------------------------
EXTENDS Naturals, TLC
CONSTANTS MaxAttempts
VARIABLES attempts, succeeded, phase, delivered
vars == <<attempts, succeeded, phase, delivered>>
Init == /\ attempts = 0 /\ succeeded = FALSE /\ phase = "due" /\ delivered = 0
FetchDue == /\ phase = "due" /\ ~succeeded /\ attempts < MaxAttempts /\ phase' = "running"
            /\ UNCHANGED <<attempts, succeeded, delivered>>
ReceiverAccepts == /\ phase = "running" /\ delivered' = delivered + 1 /\ phase' = "recordSuccess"
                   /\ UNCHANGED <<attempts, succeeded>>
Http500Resolves == /\ phase = "running" /\ phase' = "recordSuccess"
                   /\ UNCHANGED <<attempts, succeeded, delivered>>
TransportRejects == /\ phase = "running" /\ phase' = "recordRetry"
                    /\ UNCHANGED <<attempts, succeeded, delivered>>
RecordSuccess == /\ phase = "recordSuccess" /\ attempts' = attempts + 1 /\ succeeded' = TRUE
                 /\ phase' = "done" /\ UNCHANGED delivered
RecordRetry == /\ phase = "recordRetry" /\ attempts' = attempts + 1
               /\ phase' = IF attempts + 1 < MaxAttempts THEN "due" ELSE "exhausted"
               /\ UNCHANGED <<succeeded, delivered>>
Idle == phase \in {"done", "exhausted"} /\ UNCHANGED vars
Next == FetchDue \/ ReceiverAccepts \/ Http500Resolves \/ TransportRejects \/ RecordSuccess \/ RecordRetry \/ Idle
TypeOK == /\ attempts \in 0..MaxAttempts /\ succeeded \in BOOLEAN /\ delivered \in 0..1
          /\ phase \in {"due", "running", "recordSuccess", "recordRetry", "done", "exhausted"}
SuccessRecordedAfterAttempt == succeeded => attempts > 0
ExhaustedHasNoFurtherAttempt == phase = "exhausted" => attempts = MaxAttempts
Spec == Init /\ [][Next]_vars
=============================================================================
