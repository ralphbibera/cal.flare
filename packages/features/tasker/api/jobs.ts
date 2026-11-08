import { ensureDefaultCalendarsJob } from "@calcom/features/calendars/lib/tasker/trigger/ensure-default-calendars";
import { deliverWebhookJob } from "@calcom/features/webhooks/lib/tasker/trigger/deliver-webhook";
import type { Message } from "@cloudflare/workers-types";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { JobMessage } from "../queue/context";
import { isInternalJobDispatch } from "../queue/internal-dispatch";
import { consumeJobBatch } from "../queue/JobQueue";

type DeliveredJob = { runId: string; attempts: number };
type JobOutcome = { retry?: true; delaySeconds?: number };

const QUEUE_JOBS = [ensureDefaultCalendarsJob, deliverWebhookJob];

export async function handler(request: NextRequest) {
  if (!isInternalJobDispatch()) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { jobs } = (await request.json()) as { jobs: DeliveredJob[] };
  const outcomes: JobOutcome[] = jobs.map(() => ({}));
  const messages = jobs.map((job, index) => toMessage(job, index, outcomes));
  await consumeJobBatch({ messages }, QUEUE_JOBS);
  return NextResponse.json({ outcomes });
}

function toMessage(
  { runId, attempts }: DeliveredJob,
  index: number,
  outcomes: JobOutcome[]
): Message<JobMessage> {
  return {
    id: String(index),
    timestamp: new Date(),
    body: { runId },
    attempts,
    ack: () => {
      outcomes[index] = {};
    },
    retry: (options) => {
      outcomes[index] = { retry: true, delaySeconds: options?.delaySeconds };
    },
  };
}
