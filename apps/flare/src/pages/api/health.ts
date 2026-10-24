import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  try {
    const result = await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>();
    if (result?.value !== 1) {
      return Response.json({ status: "unavailable" }, { status: 503 });
    }
    return Response.json({ status: "ok", storage: "d1" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
};
