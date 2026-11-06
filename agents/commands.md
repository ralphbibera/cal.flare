# Build, Test & Development Commands

Use the existing workspace scripts through Bun. Installation and environment setup are in [README Setup](../README.md#setup).

## Development Commands

- `bun run dev` - Start development server for web app
- `bun run dev:all` - Start the configured web, API v2 and docs workspaces
- `bun run dev:api` - Start web and the API v2 Worker
- Development database setup: follow [README Setup](../README.md#setup) for local D1 and synthetic fixtures.

## Build Commands

- `bun run build` - Build all packages and apps
- `bun run clean` - Remove build artifacts (node_modules, .next, .turbo, dist)

## Lint & Type Check

- `bun run lint` - Run Biome across the codebase
- `bun run lint:fix` - Run Biome and apply safe fixes
- `bun run lint:report` - Generate Biome lint report
- `bun run type-check` - Run TypeScript type checking
- `bun run format` - Format code with Biome

## Testing Commands

### Unit Tests

- `bun run test` - Run unit tests (vitest)
- `bun run test <filename>` - Run tests for specific file
- `bun run test <filename> -t "<testName>"` - Run specific test by name for specific file
- `bun run tdd` - Run tests in watch mode
- `bun run test:ui` - Run tests with UI interface

### Integration Tests

- `VITEST_MODE=integration bun run test` - Run integration tests (vitest)
- `VITEST_MODE=integration bun run test <filename>` - Run integration tests for specific file
- `VITEST_MODE=integration bun run test <filename> -t "<testName>"` - Run specific integration test by name for specific file


### End-to-End Tests

- `bun run e2e` - Run end-to-end tests (Playwright)
- `bun run e2e <filename>` - Run E2E tests for specific file
- `bun run e2e <filename> --grep "<testName>"` - Run specific E2E test by name
- `bun run e2e:app-store` - Run app store E2E tests
- `bun run e2e:embed` - Run embed E2E tests
- `bun run test-e2e` - Run database seed + E2E tests

## Database Commands

- `bun run prisma` - Run Prisma CLI commands
- `bun run --cwd packages/prisma db-seed:d1 --local-only` - Apply D1 migrations, then seed the web Worker's local D1 (`apps/web/.cloudflare/state`) with the retained test fixtures. Re-running adds no rows; `--persist-to <dir>` targets another state directory.
- `bun run db-deploy` - Apply converted D1 migrations through the ported database script.
- Inspect local data with the D1 development tools described in the [Cloudflare reference](../docs/cloudflare.md#prepare-d1).

## App Store Commands

- `bun run create-app` - Create new app store integration
- `bun run edit-app` - Edit existing app
- `bun run delete-app` - Delete app
- `bun run app-store:build` - Build app store
- `bun run app-store:watch` - Watch app store for changes

## Useful Development Patterns

### Running Single Tests

```bash
# Unit test specific file
bunx vitest run packages/lib/some-file.test.ts

# Integration test specific file
VITEST_MODE=integration bun run test routing-form-response-denormalized.integration-test.ts

# E2E test specific file
bun run e2e tests/booking-flow.e2e.ts

# Run specific test by name
bun run e2e tests/booking-flow.e2e.ts --grep "should create booking"
```

### Environment Setup

Follow [README Setup](../README.md#setup). The [Cloudflare reference](../docs/cloudflare.md) describes resource bindings and secrets; the [integration section](../README.md#integrations) retains provider registration and callback instructions.
