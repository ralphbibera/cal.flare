import { getD1Database } from "@calcom/prisma/d1";

// Stands in for vinext's router, which only exists in a full app build. The Worker re-exports this
// module's named exports as entrypoints, so it exports nothing else.
export default {
  async fetch(request: Request, env: { SCHEDULE_TEST_FAILING_PATH?: string }) {
    const { pathname: path } = new URL(request.url);
    const recorded = {
      method: request.method,
      path,
      authorization: request.headers.get("authorization"),
      d1: Boolean(getD1Database()),
    };
    console.log(`schedule-test-request ${JSON.stringify(recorded)}`);
    if (path === env.SCHEDULE_TEST_FAILING_PATH)
      return new Response("Internal Server Error", { status: 500 });
    // Healthy routes finish after the failing one, so an early abort on failure would drop them.
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log(`schedule-test-completed ${path}`);
    return Response.json({ ok: true });
  },
};
