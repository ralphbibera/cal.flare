---
paths:
  - "packages/prisma/**"
title: Prisma Schema and Migrations
impact: HIGH
impactDescription: Schema changes affect all downstream code and deployments
tags: prisma, database, migrations, schema
---

# Prisma Schema and Migrations

## After Schema Changes

After making changes to the Prisma schema in Cal.flare and creating migrations, you need to run:

```bash
bun run prisma generate
```

This updates the TypeScript types. This is especially important:
- When switching Node.js versions
- After adding new fields to models
- After pulling changes that include Prisma schema updates

## Creating Migrations

Create ordered SQLite SQL files in `packages/prisma/migrations-d1/` and validate them against isolated local D1.
Apply the same reviewed files through the D1 migration runner for deployment. PostgreSQL `prisma migrate dev` and `db-deploy` implementations are replaced by that D1 path.
See the [D1 schema/migration contract](../../docs/porting/architecture.md#full-d1-schema-and-atomicity) for SQL representation and history handling.

## Timestamp Fields

When adding timestamp fields like `createdAt` and `updatedAt`:
- Do not set default values if you want existing records to have null values
- Only new records should get timestamps automatically
- For `updatedAt` fields, ensure they're updated when records are modified

## Squash Migrations

Consolidate unapplied local schema changes before committing their D1 migration when appropriate.
Keep already-applied migration history intact and add a forward migration for an existing database.

## Enum Generator Errors

If you encounter enum generator errors during the Prisma generate step (like "Cannot find module './enum-generator.ts'"), run `bun install --frozen-lockfile` first before trying to generate.

## Cache-Related Features

When implementing cache-related features that require timestamp tracking, always update the database schema first before modifying application code that references those fields.
