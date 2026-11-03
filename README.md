# Cal.flare

Cal.flare is a fresh Cal.diy port for Cloudflare Workers and D1.
It preserves Cal.diy's scheduling product, original UI, routes, copy and integrations while replacing incompatible hosting and persistence boundaries.

The source baseline is [Cal.diy main at e8afecd1](https://github.com/calcom/cal.diy/commit/e8afecd163cd3a0a3ff279bd4721aa7f073c4685), observed on November 4, 2026.
This first PR establishes the architecture and complete source inventory. The application has not yet been migrated or accepted on Workers.

## Target stack

- vinext preserves the Next-compatible App Router, Pages Router, layouts, components and server actions on Cloudflare Workers.
- React 19 supplies the UI and RSC runtime. The baseline still declares React 18 until the toolchain migration.
- D1 stores all application data. Prisma retains the domain boundary where compatible; PostgreSQL-specific queries and atomic writes are explicitly migrated.
- Self-hosted auth runs inside Workers with D1. Original identity, session, OAuth, MFA, recovery and permission behavior remains the product contract.
- i18next and react-i18next retain translation resources and keys while Next-specific resource loading is replaced.
- Cloudflare-native job, queue and state adapters replace incompatible hosting only where the original behavior needs them.

Exact versions, configuration choices, data shapes and adapter responsibilities are bound in [architecture](docs/porting/architecture.md).
External PostgreSQL and Node application hosting are not deployment options. Tooling requirements are separate from application hosting.

## What 1:1 means

The same actor, starting state, configuration and input sequence must produce the same observable UI, HTTP result, persisted state and provider effects as the baseline.
That includes permissions, errors, redirects, retries, partial failures, translations and source-specific ordering.
A build, screenshot or model pass alone does not establish parity.

Read the [behavior contract](docs/porting/behavior.md) and its [bounded statecharts](docs/porting/models/README.md).
The latest baseline attempts booking confirmation emails even when calendar integrations fail, subject to existing suppression settings.

## Source layout

The original structure stays intact:

```text
apps/web/app/          App Router routes, layouts and server actions
apps/web/pages/        Pages Router views and API handlers
apps/web/modules/      Web-specific feature compositions
apps/web/public/       Public assets at their original URLs
apps/api/v2/src/       Versioned API controllers, DTOs, guards and services
apps/docs/             Documentation source
packages/features/     Shared product behavior
packages/app-store/    Integrations and their metadata
packages/prisma/       Data boundary and planned D1 migrations
packages/i18n/         Translation resources and loading
packages/embeds/       Embed SDKs and browser integration
```

The [source map](docs/porting/inventory/source-map.tsv) accounts for every tracked baseline file.
[Route, dependency, integration, schedule and environment inventories](docs/porting/inventory/README.md) bind the remaining surfaces.
Original paths are preserved unless a specifically evidenced adaptation requires a change.

## Work on the port

Start with the [plan](docs/porting/plan.md), [execution rules](docs/porting/execution.md) and [verification contract](docs/porting/verification.md).
Each implementation slice owns a complete observable flow and its consumed prerequisites.
Do not broaden a slice to fill worker slots or invent features for dangling upstream declarations.

The first PR contains Markdown, Mermaid/model documentation and static inventories only. It adds no scripts, dependencies, runtime code or CI workflow.
Existing project checks stay unchanged. Inspect the scoped documentation diff with:

```sh
git diff --check
git diff --name-only e8afecd163cd3a0a3ff279bd4721aa7f073c4685...HEAD
```

The PR records one-time checks of complete source accounting, references and model artifacts.

The baseline still contains upstream build scripts and dependency declarations. They are not a working Cloudflare setup.
The toolchain slice introduces the bound vinext/Bun commands and Workers configuration. No new runtime setup or deployment is claimed by this PR.
Do not connect real credentials or private data. Deployment and provider delivery require their own prepared procedure and authorization.

## Status and evidence

Specification, implementation, local behavioral parity, real provider delivery and deployed acceptance are separate milestones.
The [plan](docs/porting/plan.md) records what each milestone must prove.
The retained models cover finite source abstractions; they do not prove full-product parity, D1 atomicity or unrestricted concurrency.

## License and lineage

Cal.flare starts from [Cal.diy](https://github.com/calcom/cal.diy), based on Cal.com.
The upstream [MIT license](LICENSE), copyright notices and source attribution remain intact.
