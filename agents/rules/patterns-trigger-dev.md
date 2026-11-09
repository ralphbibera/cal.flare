---
title: Trigger.dev Task Implementation
impact: HIGH
impactDescription: Consistent Trigger.dev patterns ensure reliable async task execution across web and API v2
tags: trigger.dev, async, tasker, concurrency, cron, scheduled-tasks
---

# Trigger.dev Task Implementation

The original Tasker definitions are shared by `apps/web` and `apps/api/v2`. Their hosted Trigger.dev execution remains the optional async runner, preserving payloads, dispatch and retry behavior. Tasks run inline unless `ENABLE_ASYNC_TASKER="true"`, `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL` are set; a failed async dispatch falls back to inline execution.

## Tasker Architecture

Every Trigger.dev feature follows the Tasker pattern with these layers:

```
packages/features/<domain>/lib/tasker/
  types.ts                    # ITasker interface + payload types
  <Domain>Tasker.ts           # Tasker subclass (dispatches async or sync)
  <Domain>TriggerTasker.ts    # Async implementation (calls .trigger())
  <Domain>SyncTasker.ts       # Sync fallback (executes inline)
  <Domain>TaskService.ts      # Business logic consumed by both
  trigger/
    config.ts                 # Queue + retry + machine config
    schema.ts                 # Zod payload schema
    <task-name>.ts            # schemaTask definition
```

Reference implementation: `packages/features/calendars/lib/tasker/` — see `CalendarsTasker.ts` for the Tasker subclass pattern and `trigger/config.ts` for queue/retry/machine configuration

## Creating a New Task

### 1. Define the Zod schema for payload validation

Always use `schemaTask` with a Zod schema for payload validation:

```typescript
// trigger/schema.ts
import { z } from "zod";

export const myTaskSchema = z.object({
  userId: z.number(),
});
```

### 2. Configure queue, retry, and machine

See `packages/features/calendars/lib/tasker/trigger/config.ts` for a real example.

```typescript
// trigger/config.ts
import { type schemaTask, queue } from "@trigger.dev/sdk";

type MyTask = Pick<Parameters<typeof schemaTask>[0], "machine" | "retry" | "queue">;

export const myQueue = queue({
  name: "my-domain",
  concurrencyLimit: 10,
});

export const myTaskConfig: MyTask = {
  machine: "small-2x",
  queue: myQueue,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 60000,
    maxTimeoutInMs: 300000,
    randomize: true,
    outOfMemory: {
      machine: "medium-1x",
    },
  },
};
```

### 3. Define the task using schemaTask

```typescript
// trigger/my-task.ts
import { schemaTask, type TaskWithSchema } from "@trigger.dev/sdk";
import type { z } from "zod";

import { myTaskConfig } from "./config";
import { myTaskSchema } from "./schema";

export const MY_TASK_JOB_ID = "domain.my-task";

export const myTask: TaskWithSchema<typeof MY_TASK_JOB_ID, typeof myTaskSchema> =
  schemaTask({
    id: MY_TASK_JOB_ID,
    ...myTaskConfig,
    schema: myTaskSchema,
    run: async (payload: z.infer<typeof myTaskSchema>) => {
      const { getMyService } = await import("@calcom/features/<domain>/di/<container>");
      const service = getMyService();
      await service.execute(payload);
    },
  });
```

### 4. For scheduled (cron) tasks, use `schedules.task`

```typescript
import { schedules } from "@trigger.dev/sdk";

export const myScheduledTask = schedules.task({
  id: "domain.my-scheduled-task",
  ...myTaskConfig,
  cron: {
    pattern: "0 0 1 * *",
    timezone: "UTC",
  },
  run: async (payload) => {
    // task logic
  },
});
```

Reference: [Trigger.dev Scheduled Tasks](https://trigger.dev/docs/tasks/scheduled)

## Concurrency Configuration

Concurrency limits control how many task runs execute in parallel within a queue. Getting this right is critical for production stability.

**How to estimate concurrency:**
1. Analyze production logs for the number of requests per minute that will trigger the task (from both `apps/web` and `apps/api/v2`)
2. Measure the average execution time of the task
3. Factor in burst patterns (e.g., peak booking hours)

**Guidelines:**
- Time-sensitive tasks (emails, webhooks) need higher concurrency
- Background jobs that are not time-sensitive can use lower concurrency
- Start conservative and increase based on production metrics

See `packages/features/calendars/lib/tasker/trigger/config.ts` (`concurrencyLimit: 10`) and `packages/features/webhooks/lib/tasker/trigger/config.ts` (`concurrencyLimit: 20`) for real examples of how concurrency is tuned per domain.

Reference: [Trigger.dev Concurrency & Queues](https://trigger.dev/docs/queue-concurrency)

## Local Development

Follow [README Setup](../../README.md#setup) for the Worker environment.
Keep the existing Tasker, SyncTasker, service and schema boundaries. Supply `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL` as Worker secrets/vars to use the hosted Trigger.dev runner; leave them unset for inline execution. See [jobs and ephemeral state](../../docs/porting/architecture.md#jobs-ephemeral-state-and-integrations).
The original `ENABLE_ASYNC_TASKER` opt-in and synchronous fallback remain part of the contract.

## Before Merging

1. Run the relevant retained task/service tests through Bun.
2. Verify the consumed task through the built Worker with local D1 and controlled queue/provider outcomes.
3. Preserve its configured concurrency, payload validation, retry factor/timing, cancellation and terminal behavior.
4. Check the source machine/OOM requirements against Worker limits; a Trigger machine tier has no literal Cloudflare equivalent.
5. Deploy the reviewed Worker/task bindings through the Cloudflare release procedure when authorized. Cherry-picking a source change alone does not deploy it.

## Common Mistakes

**Using `task` instead of `schemaTask`:**

```typescript
// Bad - no payload validation
import { task } from "@trigger.dev/sdk";
export const myTask = task({
  id: "my-task",
  run: async (payload: any) => { ... },
});

// Good - validated payload with Zod
import { schemaTask } from "@trigger.dev/sdk";
export const myTask = schemaTask({
  id: "my-task",
  schema: myTaskSchema,
  run: async (payload) => { ... },
});
```

**Missing retry or queue config:**

```typescript
// Bad - no retry or queue, will use defaults
export const myTask = schemaTask({
  id: "my-task",
  schema: myTaskSchema,
  run: async (payload) => { ... },
});

// Good - explicit config from shared config file
import { myTaskConfig } from "./config";

export const myTask = schemaTask({
  id: "my-task",
  ...myTaskConfig,
  schema: myTaskSchema,
  run: async (payload) => { ... },
});
```

**Importing eagerly inside task files instead of using dynamic imports:**

```typescript
// Bad - eager import of heavy modules at file scope
import { MyService } from "@calcom/features/domain/service/MyService";

export const myTask = schemaTask({
  id: "my-task",
  schema: myTaskSchema,
  run: async (payload) => {
    const service = new MyService();
    await service.execute(payload);
  },
});

// Good - dynamic import inside run function
export const myTask = schemaTask({
  id: "my-task",
  schema: myTaskSchema,
  run: async (payload) => {
    const { getMyService } = await import("@calcom/features/domain/di/container");
    const service = getMyService();
    await service.execute(payload);
  },
});
```

## Key References

- Trigger.dev docs: [Concurrency & Queues](https://trigger.dev/docs/queue-concurrency), [Scheduled Tasks](https://trigger.dev/docs/tasks/scheduled), [schemaTask](https://trigger.dev/docs/tasks/schemaTask)
- Example taskers in the codebase:
  - `packages/features/calendars/lib/tasker/` (standard pattern)
  - `packages/features/webhooks/lib/tasker/` (webhook delivery)
