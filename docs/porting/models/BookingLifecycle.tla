------------------------ MODULE BookingLifecycle ------------------------
EXTENDS Naturals, TLC
CONSTANTS Price, RequiresConfirmation
VARIABLES status, paid, paymentSuccess, phase, provider, replacement, oldStatus, oldDeleteCalled
vars == <<status, paid, paymentSuccess, phase, provider, replacement, oldStatus, oldDeleteCalled>>
Init == /\ status = "absent" /\ paid = FALSE /\ paymentSuccess = FALSE
        /\ phase = "new" /\ provider = "none" /\ replacement = FALSE
        /\ oldStatus = "absent" /\ oldDeleteCalled = FALSE
Persist == /\ phase = "new"
           /\ status' = IF Price = 0 /\ ~RequiresConfirmation THEN "accepted" ELSE "pending"
           /\ phase' = "ready"
           /\ UNCHANGED <<paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
ConfirmUnpaid == /\ phase = "ready" /\ status # "absent" /\ status # "accepted"
                 /\ Price > 0 /\ ~paid
                 /\ status' = "accepted"
                 /\ UNCHANGED <<paid, paymentSuccess, phase, provider, replacement, oldStatus, oldDeleteCalled>>
BeginConfirmation == /\ phase = "ready" /\ status # "absent" /\ status # "accepted"
                     /\ (Price = 0 \/ paid) /\ phase' = "confirmProvider"
                     /\ UNCHANGED <<status, paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
InitialProvider == /\ phase = "ready" /\ status = "accepted" /\ provider = "none"
                   /\ (Price = 0 \/ paid) /\ phase' = "initialProvider"
                   /\ UNCHANGED <<status, paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
ProviderReturns == /\ phase \in {"confirmProvider", "initialProvider", "receiptProvider"}
                   /\ provider' \in {"created", "failed"}
                   /\ phase' = IF phase = "confirmProvider" THEN "confirmStore" ELSE IF phase = "receiptProvider" THEN "paymentStore" ELSE "ready"
                   /\ UNCHANGED <<status, paid, paymentSuccess, replacement, oldStatus, oldDeleteCalled>>
SaveConfirmation == /\ phase = "confirmStore" /\ status' = "accepted" /\ phase' = "ready"
                    /\ UNCHANGED <<paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
PaymentCommit == /\ phase = "ready" /\ Price > 0 /\ status # "absent" /\ status # "accepted" /\ ~paid
                 /\ paid' = TRUE /\ paymentSuccess' = TRUE
                 /\ status' = IF RequiresConfirmation THEN status ELSE "accepted"
                 /\ UNCHANGED <<phase, provider, replacement, oldStatus, oldDeleteCalled>>
BeginAcceptedReceipt == /\ phase = "ready" /\ status = "accepted" /\ Price > 0 /\ ~paid
                        /\ phase' = "receiptProvider"
                        /\ UNCHANGED <<status, paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
AcceptedPaymentCommit == /\ phase = "paymentStore" /\ paid' = TRUE /\ paymentSuccess' = TRUE
                         /\ phase' = "ready"
                         /\ UNCHANGED <<status, provider, replacement, oldStatus, oldDeleteCalled>>
Reject == /\ phase = "ready" /\ status # "absent" /\ status # "accepted"
          /\ status' = "rejected"
          /\ UNCHANGED <<paid, paymentSuccess, phase, provider, replacement, oldStatus, oldDeleteCalled>>
BeginCancel == /\ phase = "ready" /\ status # "absent" /\ status # "cancelled"
               /\ phase' = "cancelWebhook"
               /\ UNCHANGED <<status, paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
CancellationWebhookAttempt == /\ phase = "cancelWebhook" /\ phase' = "cancelStore"
                              /\ UNCHANGED <<status, paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
CancelDB == /\ phase = "cancelStore" /\ status' = "cancelled" /\ phase' = "cancelProvider"
            /\ UNCHANGED <<paid, paymentSuccess, provider, replacement, oldStatus, oldDeleteCalled>>
DeleteProviderReturns == /\ phase = "cancelProvider" /\ provider' \in {"deleted", "deleteFailed"}
                         /\ phase' = "ready"
                         /\ UNCHANGED <<status, paid, paymentSuccess, replacement, oldStatus, oldDeleteCalled>>
RescheduleDB == /\ phase = "ready" /\ status # "absent" /\ ~replacement
                /\ replacement' = TRUE /\ oldStatus' = "cancelled"
                /\ status' = IF Price = 0 /\ ~RequiresConfirmation THEN "accepted" ELSE "pending"
                /\ UNCHANGED <<paid, paymentSuccess, phase, provider, oldDeleteCalled>>
CancelOld == /\ replacement /\ oldStatus # "cancelled" /\ oldDeleteCalled' = TRUE
             /\ UNCHANGED <<status, paid, paymentSuccess, phase, provider, replacement, oldStatus>>
Idle == UNCHANGED vars
Next == Persist \/ ConfirmUnpaid \/ BeginConfirmation \/ InitialProvider \/ ProviderReturns
        \/ SaveConfirmation \/ PaymentCommit \/ BeginAcceptedReceipt \/ AcceptedPaymentCommit \/ Reject \/ BeginCancel \/ CancellationWebhookAttempt
        \/ CancelDB \/ DeleteProviderReturns \/ RescheduleDB \/ CancelOld \/ Idle
TypeOK == /\ status \in {"absent", "pending", "accepted", "cancelled", "rejected"}
          /\ paid \in BOOLEAN /\ paymentSuccess \in BOOLEAN /\ replacement \in BOOLEAN
          /\ oldDeleteCalled \in BOOLEAN /\ oldStatus \in {"absent", "cancelled"}
          /\ phase \in {"new", "ready", "confirmProvider", "confirmStore", "initialProvider", "receiptProvider", "paymentStore", "cancelWebhook", "cancelStore", "cancelProvider"}
          /\ provider \in {"none", "created", "failed", "deleted", "deleteFailed"}
PaymentPair == paid = paymentSuccess
RescheduleRetainsOldCancellation == replacement => oldStatus = "cancelled"
NoOldProviderDeletion == ~oldDeleteCalled
Spec == Init /\ [][Next]_vars
=============================================================================
