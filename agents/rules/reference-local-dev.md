---
title: Local Development Setup
impact: LOW
impactDescription: Reference guide for local development environment
tags: reference, development, setup
---

# Local Development Setup

## Initial Setup

Follow [README Setup](../../README.md#setup) for Bun, local Worker configuration, D1 and first-user setup.
The [Cloudflare reference](../../docs/cloudflare.md) describes bindings, local database identity and deployed secrets.

## Test Users

Use the retained [development test users](../../README.md#development-test-users) after running the synthetic local D1 seed.

## Logging

Use the levels and configuration in [README Development tip](../../README.md#development-tip).

## API v2 Imports

If you need to import from `@calcom/features` or `@calcom/trpc` into `apps/api/v2`, use the platform-libraries package instead:

```typescript
// ✅ Good
import { SomeService } from "@calcom/platform-libraries";

// ❌ Bad - Will cause module resolution errors
import { SomeService } from "@calcom/features/...";
```
