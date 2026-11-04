---
title: CI Check Failure Handling
impact: HIGH
impactDescription: Misinterpreting CI failures wastes debugging time
tags: ci, debugging, workflow
---

# CI Check Failure Handling

## What to Focus On

When reviewing CI check failures in Cal.diy:

1. **E2E tests can be flaky** and may fail intermittently
2. **Focus only on CI failures that are directly related to your code changes**
3. Infrastructure-related failures (like dependency installation issues) can be disregarded if all code-specific checks pass

## Database Configuration Issues

The Cloudflare target uses D1. A retained upstream job requesting a PostgreSQL/SAML database identifies a job that needs the planned infrastructure substitution.
Record the affected job and baseline rather than treating a D1 failure with a similar error message as an expected PostgreSQL issue.

## E2E Tests Skipping

**E2E tests skipping is expected behavior:**
- When E2E tests are skipped, it's because the `ready-for-e2e` label has not been added to the PR
- The "required" check intentionally fails when E2E tests are skipped to prevent merging without E2E
- Do not try to fix anything related to skipped E2E tests - this is completely expected and normal

## Before Blaming CI

Always run type checks locally using `bun run type-check:ci --force` before concluding that CI failures are unrelated to your changes. Even if errors appear in files you haven't directly modified, your changes might still be causing type issues through dependencies or type inference.
