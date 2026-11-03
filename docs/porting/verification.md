# Behavioral verification contract

The original implementation at `e8afecd163cd3a0a3ff279bd4721aa7f073c4685` and its inherited assertions define expected behavior.
The [behavior catalog](behavior.md) names domain states, guards, effects, source anchors and remaining obligations.
The [models](models/README.md) cover only their explicitly bounded abstractions.

## Equivalent cases

A case identifies the actor, logical records, relation state, feature flags, missing/set environment values, locale, timezone, clock, input sequence and provider outcomes.
Acceptance observes the public result and changed state after each transition, including asynchronous completion.
It compares HTML/interaction/copy, HTTP status/body/headers/cookies/redirects, logical rows and relationships, outbound requests, recipient selection, signing, retries and partial failures.

Fix synthetic identifiers and time where supported. Otherwise use a consistent relation-preserving ID mapping and compare public formats separately.
Do not normalize away a missing effect, changed field, incorrect error, changed order or a real behavior difference.
Success and failure branches both require evidence. A screenshot, source inventory, successful build or model pass cannot substitute for a missing branch.

## Baseline evidence

Use exact baseline source and inherited fixture/assertion behavior, not an altered source file in the failed port.
A source citation proves what was inspected. It does not prove that the complete baseline application ran or that a third-party library behaves identically under a new runtime.
Reuse retained upstream snapshots, fixtures and assertions when their inputs and owning source remain valid.
Where a missing runtime observation is necessary for a parity conclusion, record that exact gap instead of fabricating the result.
Any isolated reference tooling is evidence generation, not an external PostgreSQL/Node application deployment option for Cal.flare.
The first PR neither provisions a reference service nor runs a whole-product migration prototype.

## Target evidence

Drive actual vinext route handlers, components, actions, services, repositories and provider adapters in the selected workerd/D1 environment.
Use fresh synthetic D1 state and controlled provider receivers. Do not connect private databases, real credentials or live customer data.
Observe rollback after a later write fails, duplicate/constraint behavior, source-relevant simultaneous requests, timeout, expired identity and provider failure.
Preserve the latest notification behavior even when provider event creation fails.

Browser evidence covers source-present initial/loading/empty/error/denied/populated states, keyboard/form actions, navigation/history, themes, viewport, locale and RTL behavior.
Use the original component markup and styles as the rendering contract. An isolated component fixture does not prove the page's server permissions or data-loading path.

## Evidence validity

Record the tested head, baseline, source/caller paths, commands, fixture identity/configuration, outputs and specific pass predicates.
A dependency or behavior change invalidates only affected evidence. Unchanged behavior does not need another review ceremony.
Keep implementation proof separate from real provider delivery and deployed release acceptance.
Do not copy the failed port's check status, old pin, old runtime measurements or model claims into this fresh baseline without verifying relevance.
