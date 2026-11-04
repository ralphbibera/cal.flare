---
title: Feature Flag Seeding
impact: MEDIUM
impactDescription: Proper feature flag setup enables controlled rollouts
tags: prisma, feature-flags, migrations
---

# Feature Flag Seeding

## Creating Feature Flag Migrations

To seed new feature flags in Cal.flare, add an ordered SQLite SQL migration through the [D1 migration process](data-prisma-migrations.md).

## Migration File Location

The migration file should be placed in `packages/prisma/migrations-d1/` with a timestamp prefix format:

```
20250724210733_seed_calendar_cache_sql_features.sql
```

## SQL Structure

Preserve the existing feature fields and conflict behavior, using the D1 date representation:

```sql
INSERT INTO "Feature" ("slug", "enabled", "type", "description", "createdAt", "updatedAt")
VALUES
  ('your-feature-slug', false, 'OPERATIONAL', 'Description of feature', strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'), strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))
ON CONFLICT ("slug") DO NOTHING;
```

The migration should INSERT the new features into the `Feature` table with:
- Appropriate type (like `OPERATIONAL`)
- Default `enabled` status for manual team enablement
