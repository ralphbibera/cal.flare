import type { D1Environment } from "@calcom/prisma/d1";
import { withD1Database } from "@calcom/prisma/d1";
import { withAuthRequestEnvironment } from "../../request-context";
import { hasRequestEnvironment, matchesRequest } from "./auth-request-reader.js";

export default {
  async fetch(request: Request, env: D1Environment & { SECOND: D1Environment["DB"] }): Promise<Response> {
    if (hasRequestEnvironment()) return new Response("Leaked context", { status: 500 });
    const marker = new URL(request.url).pathname.slice(1);
    const DB = marker === "first" ? env.DB : env.SECOND;
    const secret = `synthetic-request-only-${crypto.randomUUID()}`;
    const result = await withD1Database({ DB }, () =>
      withAuthRequestEnvironment({ NEXTAUTH_SECRET: secret }, async () => {
        await Promise.resolve();
        if (!(await matchesRequest(secret, marker))) return false;
        const nested = await withD1Database({ DB: env.SECOND }, () =>
          withAuthRequestEnvironment({ NEXTAUTH_SECRET: "synthetic-nested" }, () =>
            matchesRequest("synthetic-nested", "second")
          )
        );
        return nested && (await matchesRequest(secret, marker));
      })
    );
    return new Response(result && !hasRequestEnvironment() ? "isolated" : "Leaked context", {
      status: result ? 200 : 500,
    });
  },
};
