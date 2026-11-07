import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";

const DISPATCH_CRON = "* * * * *";

type ScheduleCaller = "github-workflow" | "vercel-cron";

type ProductSchedule = { cron: string; path: string; caller: ScheduleCaller };

// Rows without a handler at the pin stay out of this table. See docs/porting/inventory/schedules.tsv.
const PRODUCT_SCHEDULES: readonly ProductSchedule[] = [
  { cron: "*/15 * * * *", path: "/api/cron/bookingReminder", caller: "github-workflow" },
  { cron: "0 * * * *", path: "/api/cron/changeTimeZone", caller: "github-workflow" },
  { cron: "0 0 1 * *", path: "/api/cron/syncAppMeta", caller: "github-workflow" },
  { cron: "* * * * *", path: "/api/cron/webhookTriggers", caller: "github-workflow" },
  { cron: "*/5 * * * *", path: "/api/cron/calendar-subscriptions", caller: "vercel-cron" },
  { cron: "0 3 * * *", path: "/api/cron/calendar-subscriptions-cleanup", caller: "vercel-cron" },
  { cron: "* * * * *", path: "/api/tasks/cron", caller: "vercel-cron" },
  { cron: "0 0 * * *", path: "/api/tasks/cleanup", caller: "vercel-cron" },
  { cron: "*/5 * * * *", path: "/api/cron/selected-calendars", caller: "vercel-cron" },
];

type CallerRequest = { method: "GET" | "POST"; headers: Record<string, string> };

const CALLER_REQUESTS: Record<ScheduleCaller, (env: ScheduleEnvironment) => CallerRequest | null> = {
  // The source workflows skip their curl step when the key is unset, so nothing runs and nothing fails.
  "github-workflow": ({ CRON_API_KEY }) =>
    CRON_API_KEY
      ? { method: "POST", headers: { "content-type": "application/json", authorization: CRON_API_KEY } }
      : null,
  // Vercel still calls the route without a secret, leaving the handler to reject it.
  "vercel-cron": ({ CRON_SECRET }) => {
    const headers: Record<string, string> = {};
    if (CRON_SECRET) headers.authorization = `Bearer ${CRON_SECRET}`;
    return { method: "GET", headers };
  },
};

function matchesCronField(field: string, value: number) {
  if (field === "*") return true;
  if (/^\*\/\d+$/.test(field)) return value % Number(field.slice(2)) === 0;
  if (/^\d+$/.test(field)) return value === Number(field);
  throw new ErrorWithCode(ErrorCode.InternalServerError, `Unsupported cron field "${field}"`);
}

function isCronDue(cron: string, scheduledTime: Date) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(" ");
  return (
    matchesCronField(minute, scheduledTime.getUTCMinutes()) &&
    matchesCronField(hour, scheduledTime.getUTCHours()) &&
    matchesCronField(dayOfMonth, scheduledTime.getUTCDate()) &&
    matchesCronField(month, scheduledTime.getUTCMonth() + 1) &&
    matchesCronField(dayOfWeek, scheduledTime.getUTCDay())
  );
}

async function dispatchSchedule(
  { method, headers }: CallerRequest,
  path: string,
  fetchRoute: (request: Request) => Promise<Response>
) {
  // The origin is never contacted: the request enters this Worker's own router in-process.
  const response = await fetchRoute(new Request(`https://calflare.internal${path}`, { method, headers }));
  // A handler may still be working while its body streams, and the source callers read to the end.
  await response.arrayBuffer();
  // curl --fail and Vercel cron both treat only 4xx and 5xx as a failed run. Neither retries.
  if (response.status >= 400) throw new Error(`responded ${response.status}`);
}

export type ScheduleEnvironment = { CRON_API_KEY?: string; CRON_SECRET?: string };

export async function dispatchSchedules(
  { cron, scheduledTime }: Pick<ScheduledController, "cron" | "scheduledTime">,
  env: ScheduleEnvironment,
  fetchRoute: (request: Request) => Promise<Response>
) {
  if (cron !== DISPATCH_CRON) {
    const message = `No schedules are bound to cron "${cron}"`;
    console.error(message);
    throw new ErrorWithCode(ErrorCode.InternalServerError, message);
  }

  const minute = new Date(scheduledTime);
  const due = PRODUCT_SCHEDULES.flatMap(({ cron: scheduleCron, path, caller }) => {
    const callerRequest = CALLER_REQUESTS[caller](env);
    return callerRequest && isCronDue(scheduleCron, minute) ? [{ path, callerRequest }] : [];
  });

  // Source schedules are separate jobs, so one failing route must not stop the others.
  const outcomes = await Promise.allSettled(
    due.map(({ path, callerRequest }) => dispatchSchedule(callerRequest, path, fetchRoute))
  );
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [`${due[index].callerRequest.method} ${due[index].path} ${String(outcome.reason?.message)}`]
      : []
  );
  if (failures.length === 0) return;
  const message = `Scheduled dispatch failed: ${failures.join("; ")}`;
  console.error(message);
  throw new ErrorWithCode(ErrorCode.InternalServerError, message);
}
