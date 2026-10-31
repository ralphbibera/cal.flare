# Cal.flare agent guide

## Work in the active application

The root workspace runs `apps/flare` with Astro, React, Cloudflare Workers, and D1.
Treat `package.json` scripts as the command source of truth.
Read the [development guide](apps/flare/README.md) for setup and verification.
Read the [setup guide](apps/flare/SETUP.md) before changing operator configuration.

Inherited Cal.diy apps and packages are outside the active workspace graph.
When changing inherited code, consult the relevant [legacy rules](agents/README.md).
Do not assume its Next.js, Prisma, or Turbo commands apply to the active app.

## Keep changes understandable

- Deliver one coherent, verifiable outcome. Preserve unrelated work.
- Reuse existing implementations and tools before adding another mechanism.
- Keep each business rule and invariant with a clear owner.
- Prefer interfaces that hide meaningful decisions from callers.
- Extract helpers when they reduce caller knowledge. Question pass-through layers and speculative options.
- Use one implementation owner for shared invariants. Delegate bounded, independent questions when useful.
- Match review effort to risk. Use parallel reviewers only when their distinct questions justify the coordination.

Assess complexity through control flow, caller knowledge, coordinated edits, and hidden dependencies.
Use line and file counts as review-effort context, not hard acceptance limits.
Biome warns when a function's Cognitive Complexity exceeds 15.
Treat the warning as a prompt to inspect the design, not an instruction to split functions mechanically.
Explain necessary complexity increases and verify the relevant behavior.

## Verify with existing local tools

Use Bun 1.4.4, pinned in `package.json` and `mise.toml`, for installation and
JavaScript/TypeScript tooling. Install with `bun install --frozen-lockfile`.
Prefix commands with `mise exec --` when the pinned Bun version is not active.
The root and app `bunfig.toml` files force Bun for tools with Node shebangs. Preserve Bun in child
processes. Workerd, Chromium, and Python retain their respective execution roles.
Prefer TypeScript and Bun APIs for new active-app tooling. Validate untrusted inputs at their
boundary, keep them `unknown` until parsed, and derive types from existing schemas.
Run these commands from the repository root:

```sh
bun run lint
bun run type-check:ci --force
bun run test
```

During iteration, run Biome on the files you changed.
Run type checks for source changes and tests for affected behavior before publishing.
For documentation or lint configuration, check the changed artifact and exercise any changed rule.
Use the development guide's existing build, Worker, and browser checks when the change needs them.
For reservation invariants or migrations, use the existing
[reservation verification skill](.agents/skills/verify-booking-reservations/SKILL.md)
and `/maintain-formal-verification-skill` when its covered implementation changes.
Distinguish local fixtures from native parity, live provider delivery, and deployed behavior.
Report failed or unavailable checks and their limits. Do not weaken checks to obtain a pass.
Prefer free local verification. Add tools only when existing checks leave a concrete gap.

## Preserve safety and code contracts

- Keep secrets and private environment files out of commits, logs, and responses. Never expose `credential.key`.
- Enforce permissions at request entry points. For inherited Next.js routes, use `page.tsx`, not `layout.tsx`.
- Use type-safe code, `import type`, and direct source imports. Do not use `as any` or barrel imports.
- Use `ErrorWithCode` outside tRPC routers and `TRPCError` inside those routers.
- When touching Prisma code, use `select` rather than `include`.
- Add shared UI translations to `packages/i18n/locales/en/common.json`.
- Regenerate generated files through their existing tools. Do not edit them directly.
- Write comments for non-obvious reasons or contracts, not descriptions of the adjacent code.
- Check session authorization before adding dependencies, changing Prisma schemas or multiple packages, deleting files, or running full builds or E2E suites.
- Keep deployments and production resource changes separate from code delivery unless explicitly authorized.
- Use Conventional Commits. Create PRs only when requested and keep them draft until ready.
- Do not force-push shared branches or bypass branch protections.
