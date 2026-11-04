# Cal.flare agent guide

Read the [plan](docs/porting/plan.md), [architecture](docs/porting/architecture.md), [behavior](docs/porting/behavior.md) and [execution rules](docs/porting/execution.md) before implementation.
The exact source baseline is Cal.diy `e8afecd163cd3a0a3ff279bd4721aa7f073c4685`.
Use the [source inventory](docs/porting/inventory/source-map.tsv) for ownership and destinations. Original application and package folders remain in place.
Use Bun 1.4.4 for package management and workspace commands. Target vinext, React 19, Cloudflare Workers and full D1 persistence. External PostgreSQL and Node application hosting are out of scope.
Preserve original behavior, markup, copy, translation keys, IDs, permission checks and side-effect ordering. Package replacement does not authorize product changes.
Use vinext's supported Next interfaces. Do not introduce Astro routes or the previous attempt's custom Next runtime/codemod.
Read actual source and callers before changing a boundary. Use [inherited feature rules](agents/README.md) where applicable.
Keep one writer per path, preserve concurrent WIP, and make only changes needed by the owned flow.
Retain inherited tests and their expected behavior. Verify the actual production path, failed branches, D1 rollback and asynchronous effects. Do not invent stronger guarantees.
Baseline manifests still describe upstream tooling. Target commands and versions are the architecture's selected deliverables until the toolchain slice implements them.
Keep secrets, generated clients, local databases, logs and caches out of commits. Deployment, real credentials and live-data actions need explicit authorization.
