# Upstream source inventory

The inventory baseline is Cal.diy main at `e8afecd163cd3a0a3ff279bd4721aa7f073c4685`, observed on November 4, 2026.
The fresh fork retains the original folders. vinext provides the Next-compatible routing and component runtime.
These files bind source scope and placement. They do not claim that the source already runs on Workers or D1.

| File | Contract |
| --- | --- |
| [source-map.tsv](source-map.tsv) | Every tracked baseline file has a retained destination or explicit replacement disposition. |
| [routes.tsv](routes.tsv) | App and Pages routes, metadata assets, v2 HTTP decorators and aliases, and docs content URLs. |
| [integrations.tsv](integrations.tsv) | Every app-store definition from metadata or config, including link-only apps. |
| [manifests.tsv](manifests.tsv) | Every direct dependency edge at the baseline. Original ranges are not selected target versions. |
| [schedules.tsv](schedules.tsv) | Vercel schedules, GitHub workflow methods and conditions, and matching or absent handlers. |
| [environment.tsv](environment.tsv) | Static and computed environment references. No values or secrets. |
| [summary.json](summary.json) | Baseline and reproducible counts. |

`source` names the original upstream path. Read it with `git show e8afecd163cd3a0a3ff279bd4721aa7f073c4685:<source>`.
`retain-adapt-in-place` preserves original ownership and import paths. It is not a runtime verdict.
`git-history/` is a retirement disposition, never a directory to create. The old host's responsibilities must be adopted before removing its implementation.
PostgreSQL migration files are reference history. Target D1 migrations are new ordered SQL migrations under `packages/prisma/migrations-d1/`.
Pinned `.env` values never become committed target configuration.
Example apps remain outside product acceptance. The session-warmup route remains inherited test support.

`domain` is a path-based discovery index, not a security boundary or an assertion that a file serves only one feature.
The [behavior contract](../behavior.md) binds actual transitions and effects. Cross-domain callers remain obligations of their implementation slice.

The route inventory describes declarations. It does not replace the running router, middleware, configuration, or generated OpenAPI document.
Route groups disappear from URLs. Optional catch-alls, metadata routes, App/Pages precedence and redirects retain upstream behavior through vinext.
The two favicon sources remain distinct at their original paths. No manual flattening or overwrite is allowed.
App API methods come from actual exports. Pages API method dispatch remains inside its handler.
v2 controller paths mount under `/api/v2`; their version constants, guards, DTOs and aliases remain part of the contract.
The v2 Worker adapter belongs to `apps/api/v2/src/worker.ts`. This is not permission to run a Nest Node host.

US and EU workflow requests have separate rows and separate guards. Each enabled region sends its own request; configuring one region does not require the other.
Scheduled URLs without a declared handler are marked `absent-at-pin` with destination `no-product-handler`.
Check middleware and rewrites, preserve the absent-handler result, and invent no new job or Cron Trigger for them.
Repository-maintenance schedules remain GitHub automation. Product schedules move to Worker dispatch with their method, auth and calendar conditions.
Metadata enablement variables do not cover every credential consumer. Use the environment inventory and implementation source as well.

The inventories were derived from baseline Git objects and verified once during this PR. No generator or new repository script is introduced.
Use `git ls-tree -r --name-only e8afecd163cd3a0a3ff279bd4721aa7f073c4685` to inspect the authoritative source set.
The source-map rows must match that set exactly, with no duplicate or blank dispositions.
A static count or valid source reference proves accounting, not semantic equivalence, provider delivery or deployability.
An in-scope source remains included unless a specifically evidenced licensing exclusion or operator-approved deviation says otherwise.
