import { ensureDefaultCalendarsJob } from "@calcom/features/calendars/lib/tasker/trigger/ensure-default-calendars";
import { deliverWebhookJob } from "@calcom/features/webhooks/lib/tasker/trigger/deliver-webhook";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isInternalJobDispatch } from "../queue/internal-dispatch";
import type { JobDelivery } from "../queue/JobQueue";
import { runJobs } from "../queue/JobQueue";
import type { JobQueueName } from "../queue/queues";

const QUEUE_JOBS = [ensureDefaultCalendarsJob, deliverWebhookJob];

export async function handler(request: NextRequest) {
  if (!isInternalJobDispatch()) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { queue, jobs } = (await request.json()) as { queue: JobQueueName; jobs: JobDelivery[] };
  const handlers = QUEUE_JOBS.filter((job) => job.queue === queue);
  return NextResponse.json({ outcomes: await runJobs(jobs, handlers) });
}
