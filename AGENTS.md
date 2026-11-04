# Cal.flare development guide for AI agents

Work within the existing Cal.diy monorepo. Prioritize type safety, security, small reviewable changes and equivalent product behavior.
Use the [port plan](docs/porting/plan.md), [architecture](docs/porting/architecture.md), [behavior contracts](docs/porting/behavior.md) and [execution rules](docs/porting/execution.md).
The baseline is Cal.diy `e8afecd163cd3a0a3ff279bd4721aa7f073c4685`. The [source inventory](docs/porting/inventory/source-map.tsv) records ownership and destinations.

## Do

- Use `select` instead of `include` in Prisma queries to control data exposure and query size.
- Use `import type { X }` for TypeScript type imports.
- Use early returns to reduce nesting, such as `if (!booking) return null;`.
- Use `ErrorWithCode` in services, repositories and utilities. Use `TRPCError` in tRPC routers.
- Use Conventional Commits, such as `feat:`, `fix:` and `refactor:`.
- Import directly from source files, such as `@calcom/ui/components/button`. Preserve an established public boundary where required, such as the v2 platform-library exports.
- Keep permission checks at each page, action and procedure boundary. A layout does not authorize its descendants.
- Preserve original markup, class names, copy, translation keys, routes and public response contracts.
- Preserve existing date libraries and timezone behavior during the port. For new code without timezone requirements, prefer native `Date` or the existing date-fns utilities.
- Put approved new UI strings in `packages/i18n/locales/en/common.json`; do not introduce untranslated copy.
- Use Biome for supported source formatting and linting.
- Add comments only for non-obvious reasons. Follow [code comment guidelines](agents/rules/quality-code-comments.md).
- Read the actual source and callers before changing a boundary. Use scoped Context.dev `sgrep` discovery and inspect source lines; report unavailable search setup.
- Keep one writer per path and preserve concurrent work, local data, logs and caches.
- Reproduce a defect where feasible, then verify the changed production path and affected callers.

## Don't

- Do not use `as any`; define the actual contract and validate untrusted input at its boundary.
- Never expose `credential.key`, provider tokens or private configuration in responses, queries or browser bundles.
- Never commit secrets, API keys, `.env`, `.dev.vars` or private database state.
- Never edit `*.generated.ts`, generated clients or binding declarations by hand. Change the source generator or schema.
- Keep business policy in the existing service layer. Repositories own persistence, query semantics and atomic write guards.
- Do not introduce new barrel dependencies or move web-only tRPC hooks into shared feature packages.
- Do not skip applicable type checks, lint or verification before pushing.
- Do not rewrite existing code for stylistic preference or add unrelated cleanup while migrating a flow.
- Do not replace original components with approximations or add features and guarantees absent from the baseline.
- Do not add tests solely to prove documentation edits, file moves or deletions.
- Do not hide newly reached failures with stubs, fake sessions, source exclusions or weakened checks.

## PR size guidelines

Keep one responsibility per PR. Prefer fewer than 500 changed code lines and ten code files where the result remains coherent.
Documentation, generated inventories and lockfiles are excluded from those code-size guidelines.
A guideline is not a reason to split one runnable flow into incomplete layers or create a PR for each small file edit.

### Split changes by verifiable outcome

1. Deliver the smallest complete user or provider flow with its implementation, integration and verification.
2. Separate a prerequisite only for an actual dependency, compilation or runtime reason. State which product acceptance it enables.
3. Keep behavior-preserving refactoring separate from a product behavior change when both can be independently verified.
4. Order dependent PRs by their real prerequisites. Preserve existing owners and reconcile bases after a prerequisite lands.

For example, a calendar transport adapter may be a prerequisite if the original SDK cannot import in workerd.
The consuming slice then completes calendar creation, updates, cancellation and failure handling through the original booking path.
Do not substitute repeated review rounds or worker-count targets for completing that flow.

## Commands

Use Bun `1.4.4` for package management and workspace commands. See the [Bun migration contract](docs/porting/architecture.md#bun-workspaces-and-lockfile).
The source manifests still contain upstream commands until the [toolchain milestone](docs/porting/plan.md#phase-1-establish-the-original-application-on-vinext) converts them.
The target command interface is:

```sh
bun install --frozen-lockfile
bun run lint
bun run type-check:ci --force
TZ=UTC bun run test
bun run --cwd packages/prisma generate
bun run --cwd apps/web dev
bun run --cwd apps/web build
```

Bun runs the existing package scripts. Vitest remains the unit runner and Playwright remains the browser runner.
Preserve dependency resolutions, workspace names, overrides, patches and required lifecycle behavior when producing `bun.lock`.
Use frozen installs in CI. Remove Yarn commands and files after their consumed replacements work.
Node is available for build tools whose engine contracts require it; it is not an application server.

[agents/commands.md](agents/commands.md) retains upstream command details. The selected architecture and converted manifests take precedence over obsolete Yarn or PostgreSQL instructions.
Do not report a command as passing until it exists, targets the accepted source graph and actually executes.

## Boundaries

### Always do

- Run type checks for changed typed code and its affected callers before committing.
- Run relevant retained tests and scoped runtime verification before pushing implementation changes.
- For documentation changes, check source claims, relative links, anchors and whitespace. Do not claim runtime acceptance from those checks.
- Use Prisma `select`, direct imports, existing domain types and source-compatible errors.
- Keep public API methods, status codes, body shapes, cookies, redirects and validation behavior stable.
- Preserve IDs, relationships, defaults, JSON/list semantics, date representations and source-specific side-effect ordering on D1.
- Keep transactional guards and dependent writes in one atomic D1 batch, and prove rollback and relevant concurrency behavior.
- Follow the active task's delivery grant. Full-stop leaves the PR open and unmerged, with auto-merge and queue enrollment off.

### Resolve within the authorized task

Dependency, schema, multi-package and file changes named by the port plan may proceed within the active execution grant.
Make routine choices directly and record consequential decisions with their evidence.
Do not ask the operator to approve an already-authorized reversible step again.

### Ask first

- Product or scope changes that alter the baseline's observable behavior.
- Unclear licensing or a proposed exclusion without evidence.
- Production deployment, real provider credentials or paid-resource creation.
- Migrating or deleting live data, changing branch protection, or another action outside the active grant.

### Never do

- Commit secrets or expose credential fields.
- Run production requests against private data to create verification evidence.
- Force-push or rebase another owner's shared branch.
- Bypass branch protection or merge without the relevant authorization.
- Treat package support documentation, a successful build or a bounded model as proof of full-product parity.

## Project structure

```text
apps/web/app/                App Router routes, layouts, RSC and actions
apps/web/pages/              Pages Router views and API handlers
apps/web/modules/            Web-specific feature compositions and tRPC hooks
apps/web/components/         Web components shared across those views
apps/api/v2/src/             Versioned controllers, DTOs, guards and services
apps/docs/                   Documentation application
packages/prisma/             Domain schema, client and planned D1 migrations
packages/trpc/               API procedures, contexts and React bindings
packages/ui/                 Shared UI components
packages/features/           Shared services, repositories and domain code
packages/app-store/          Provider integrations, metadata and credentials
packages/lib/                Shared utilities and transport boundaries
packages/i18n/               Original translations and resource loading
packages/embeds/             Embed SDKs and browser integration
```

### Key files and references

- Domain schema is `packages/prisma/schema.prisma`; target SQLite migrations belong in `packages/prisma/migrations-d1/`.
- tRPC procedures live under `packages/trpc/server/routers/`.
- Translation keys live in `packages/i18n/locales/en/common.json`.
- Existing task execution lives under `packages/features/tasker/`; webhook triggers live under `packages/features/webhooks/`.
- Each application's target `vite.config.ts` and `cloudflare.config.ts` own its build and Cloudflare bindings.
- Use the [Cloudflare guide](docs/cloudflare.md) and [integration guide](docs/integrations.md) for setup responsibilities and provider callbacks.
- Preserve the [feature/module boundary](agents/rules/architecture-features-modules.md) and [page-level authorization](agents/rules/architecture-page-level-auth.md).

## Target stack

- Framework is vinext with the original Next-compatible App Router and Pages Router interfaces.
- UI uses React 19, original components, Tailwind CSS and original provider composition.
- Language is strict TypeScript.
- Application hosting uses Cloudflare Workers; complete relational persistence uses D1 with Prisma.
- tRPC retains its public procedure and serialization contracts. API v2 uses the selected Fetch/Hono boundary.
- Better Auth is self-hosted on Workers and D1 behind Cal's original auth policy and projections.
- i18next and react-i18next retain original resources while Next-specific loading is replaced.
- Queues, Cron Triggers and Durable Objects replace the selected incompatible job/state hosting boundaries.

Exact pins and ownership are in [architecture](docs/porting/architecture.md).
External PostgreSQL and Node application hosting are out of scope. Use vinext's supported `next/*` interfaces rather than custom framework shims or Astro adapters.

## Code examples

### Error handling

Keep useful context and the caller's error contract:

```typescript
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";

throw new ErrorWithCode(ErrorCode.BookingNotFound, "Booking not found");
```

Use `TRPCError` inside a tRPC router. Follow [error handling patterns](agents/rules/quality-error-handling.md) for the existing conversion middleware and HTTP factories.
Do not change a pinned error message or status simply to improve its wording.

### Prisma queries

Select the fields the caller needs:

```typescript
const booking = await prisma.booking.findFirst({
  select: {
    id: true,
    title: true,
    user: {
      select: {
        id: true,
        name: true,
        email: true,
      },
    },
  },
});
```

An unrestricted `include: { user: true }` can return sensitive or unnecessary fields.
A nested write that changes multiple rows also needs the D1 atomicity contract; selecting carefully does not establish rollback.

### Imports

```typescript
import type { User } from "@prisma/client";
import { Button } from "@calcom/ui/components/button";
```

Keep type-only imports explicit and import the component's source entry rather than the `@calcom/ui` barrel.

### API v2 imports

The inherited v2 tsconfig does not map every feature/tRPC source alias.
Preserve the existing `@calcom/platform-libraries` boundary until a deliberate alias migration updates both its compiler and Worker build.
For an existing shared export, use:

```typescript
import { ProfileRepository } from "@calcom/platform-libraries";
```

If that export is missing, add it to its existing owner before using it:

```typescript
export { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
```

Do not assume a new direct `@calcom/features` import resolves in v2 merely because it works in the web app.

## PR checklist

- [ ] Title uses a Conventional Commit type and appropriate scope.
- [ ] The PR delivers one coherent result with clear source and destination ownership.
- [ ] Applicable type checks, Biome checks and retained tests pass on the actual accepted graph.
- [ ] Relevant runtime failure, permission, persistence and provider paths have evidence.
- [ ] Documentation links and claims are valid when documentation changes.
- [ ] No secrets, private data or hand-edited generated output are committed.
- [ ] Markup, copy, translation keys and public contracts remain source-compatible.
- [ ] Review findings are resolved or answered with evidence.
- [ ] Head, base, required checks and mergeability match the delivery report.
- [ ] Automatic landing and merge behavior respect the active task's grant.

## When stuck

- Trace a failure to its source before adding another workaround.
- Reproduce a claimed inherited failure against the same base before calling it unrelated.
- Resolve type errors before interpreting downstream test failures.
- Regenerate Prisma output if generated enums or client types are missing; never patch generated files.
- Use a bounded experiment for a factual runtime uncertainty and record its outcome.
- Ask about genuine product decisions or external gates after completing independent authorized work.
- Keep the current contract's unproven branches explicit instead of claiming blanket acceptance.

## Specification-driven work

The port follows its committed plan and behavior contracts. Update those shared decisions when an implementation discovery affects multiple slices.
For separately authorized work that needs the extended specification workflow, see [SPEC-WORKFLOW.md](SPEC-WORKFLOW.md).
Do not create another planning system merely because a task spans multiple files.

## Extended documentation

- [agents/README.md](agents/README.md) indexes the inherited engineering rules.
- [agents/rules/](agents/rules/) contains domain, repository, API, testing and review conventions.
- [agents/commands.md](agents/commands.md) describes inherited command details.
- [agents/knowledge-base.md](agents/knowledge-base.md) records business rules.
- [Port plan](docs/porting/plan.md), [architecture](docs/porting/architecture.md) and [behavior](docs/porting/behavior.md) bind the target migration.
