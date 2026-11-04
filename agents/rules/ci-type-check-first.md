---
title: Type Check Before Tests
impact: HIGH
impactDescription: Type errors are often the root cause of test failures
tags: ci, typescript, type-check, workflow
---

# Type Check Before Tests

## Priority Order

When working on the Cal.diy repository, prioritize fixing type issues before addressing failing tests.

1. Run `bun run type-check:ci --force` first
2. Fix all TypeScript errors
3. Then run tests with `TZ=UTC bun run test`

## Why Type Check First

Type errors are often the root cause of test failures. Fixing types first:
- Eliminates cascading failures
- Ensures code compiles correctly
- Catches issues that tests might miss

## Comparing Branches

Compare type check results between the main branch and your feature branch to confirm whether you've introduced new type errors:

```bash
# On your branch
bun run type-check:ci --force 2>&1 | tee /tmp/feature-types.log

# On main
git checkout main
bun run type-check:ci --force 2>&1 | tee /tmp/main-types.log

# Compare
diff /tmp/main-types.log /tmp/feature-types.log
```

## Missing Enum Errors

If you encounter errors related to missing enum values (like `CreationSource.WEBAPP`), running `bun run prisma generate` will typically resolve these issues by regenerating the TypeScript types from the schema.
