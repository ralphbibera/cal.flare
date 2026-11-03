# Execute a clean port slice

Use [the plan](plan.md), [architecture](architecture.md), [behavior](behavior.md), [inventory](inventory/README.md) and [verification contract](verification.md).
The exact baseline is `e8afecd163cd3a0a3ff279bd4721aa7f073c4685`.
The first PR changes specification and documentation only. Its full-stop grant never authorizes merge, auto-merge, queue enrollment or default-branch pushes.

## Bind one result before editing

Each task packet or PR contains the following information. Reuse the normal task and PR description rather than another coordination system.

| Field | Required content |
| --- | --- |
| Result | One complete user/provider flow, or a concrete prerequisite that enables it. |
| Source | Exact inventory paths, exports, callers, baseline predicates and retained test cases. |
| Destination | Original owning folders and public URLs, plus specifically selected new infrastructure files. |
| Behavior | Actor, initial records, configuration, inputs, guards, output, rows changed, external effects and their order. |
| Failure | Source-present denial, invalid input, missing/expired resource, provider failure, partial write, retry and concurrency branches. |
| Dependency | Consumed query, identity, runtime, framework, transport and atomic-write contracts. |
| Owner | One writer per path. Existing work remains with its owner until a clear handoff. |
| Base | Fresh fork base SHA and exact prerequisite PR head, if actually needed. |
| Evidence | Commands, synthetic fixture/clock/config, expected result, actual result and pass predicate. |
| Limits | Named unproven branches, external delivery gates and specifically approved deviations. |

A file assignment is not a completed flow. Do not create work, reviewers or watchdogs merely to fill worker slots.
Independent work requires disjoint ownership and dependency-ready contracts. No nested delegation by default.

## Keep original ownership

Keep App Router source under `apps/web/app`, Pages Router source under `apps/web/pages`, and their original views/providers/modules in place.
Keep shared domain services, repositories and integration adapters in their existing packages.
Keep v2 DTOs, guards, services and versioned controllers under `apps/api/v2/src` while replacing the Node HTTP host.
vinext owns supported `next/*` framework behavior. Do not copy the failed port's custom runtime or rewrite Next imports to Astro adapters.
Do not redesign components, move everything into a new feature framework, change copy or add guarantees absent from the baseline.
Any necessary source move uses `git mv` before its adaptation commit.

## Resolve real dependencies

Public rendering consumes its reads, translations, assets, providers and routing behavior.
Booking submission additionally consumes validation, availability, provider boundaries and atomic writes.
Authenticated pages/procedures consume the actual session and permission projection, not a stubbed identity.
A v2 endpoint consumes its DTO, guards, service, version selection, response transformation and any required state/queue operations.
A background operation consumes its due predicate, source attempts/retries, cancellation and durable effects.
Full release consumes every in-scope contract, complete graph activation and authorized provider/deployment evidence.

Finish only the prerequisites a slice actually consumes. Unrelated integration reads do not block an atomic booking write.
A partial accepted graph never grants full-product acceptance.
Installing a package, importing a source file or returning 200 from a stub does not prove its runtime contract.

## Bind D1 and asynchronous boundaries

Keep domain IDs, UIDs, keys, relations, defaults, dates, enum/JSON representations, null behavior, ordering, aggregation and error mapping.
Rewrite PostgreSQL-specific queries at their original owning boundaries.
Keep source guards and dependent writes in one D1 batch with rollback on any failure.
An earlier unguarded read and later batch are not one transaction.
Provider calls remain outside DB transactions and keep source-specific before/after ordering and partial failures.
Do not infer no-overlap booking protection, globally serial execution or exactly-once provider delivery from a local model.

Preserve the baseline's independent booking, payment, provider and notification states.
Latest upstream attempts confirmation emails even when all calendar/video integration results fail, subject to existing suppression flags.
Task, Trigger and Queue retry policies are distinct. Transport redelivery must not silently redefine a logical application attempt.
An enqueue record is not evidence of delivered email, signed webhook receipt or provider calendar state.

## Verify on the actual surface

Use inherited tests and their original assertions. Adapt their runtime/DB/bootstrap to the selected target without replacing their expected behavior.
For uncovered behavior, use direct operational observations against the real production path with isolated synthetic state.
No replacement port-only suite, deletion inventory or parallel test framework is required.
TLA+ checks a bounded abstraction. It cannot prove D1 atomicity or that implementation matches the model.

The first PR contains documentation and static inventories only. It adds no scripts, dependencies, runtime implementation or CI workflows.
Keep existing project checks unchanged. Run `git diff --check` and inspect the scoped source diff.
Record one-time exhaustive inventory, source-anchor, relative-link and model-artifact validation in the PR.
These checks do not install or claim a working vinext application.

The source baseline still contains upstream Yarn/Next/PostgreSQL tooling until the implementation slices replace it.
Target application hosting remains Workers and target persistence remains D1. Baseline tooling is not a supported deployment alternative.

The toolchain slice supplies the planned Bun scripts `lint`, `type-check:ci`, `test`, app `check:compat`, `build` and `preview`.
The browser slice reconnects retained Playwright journeys. The v2 slice reconnects its retained end-to-end cases and OpenAPI generation.
No command counts as proof before its runner exists, targets the accepted graph and actually executes the named behavior.
Read the fresh repository's required checks and protection. Do not carry check names or status claims from the failed repository.
Never bypass protection, soften checks to hide reachable failures or claim an inherited test passed because its file exists.

## Measure equivalent work

Record Worker bundle/startup, browser payloads, D1 reads/writes and affected flow latency for the actual accepted graph.
Use identical logical fixture data and actor/configuration when comparing outcomes.
Record environment, runtime, sample statistic and regression rule before interpreting measurements.
A product/platform limit needs an authoritative requirement. A single local timing sample does not establish a universal budget.
Do not repeatedly rerun an unchanged failure or label it a flake without evidence.
Use current official Cloudflare limits for the selected account before release capacity claims.

## Deliver only the authorized task

Inspect the actual source/caller diff and applicable behavior contract.
Use independent review when required or a concrete unresolved concern warrants it. Reuse valid evidence for unchanged behavior.
Fix demonstrated findings. Dismiss unsupported findings with direct evidence.
Observe final head/base, checks, configured reviews, mergeability, draft state and automatic landing.
Full-stop ends with an open, unmerged, merge-ready PR and auto-merge/queue enrollment disabled.
A required human approval is a wait. Missing proof or a failing gate is a blocker, not readiness.

## Record deviations and external gates

An implementation discovery does not silently change scope.
Record exact affected source, baseline result, target limitation, selected alternative, visible difference and verification in the owning PR.
Update the shared architecture or behavior contract when the decision affects multiple slices.
Real credentials, paid resource creation, production deployment, live-data migration/deletion, unclear licensing and product-scope changes need the operator's decision.
While an external gate is open, continue independent local work. Do not present synthetic provider responses as real delivery.
