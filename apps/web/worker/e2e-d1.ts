import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";

declare const __CALFLARE_E2E_D1__: boolean;

const statementSchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).default([]),
  mode: z.enum(["all", "run", "raw", "first"]).default("all"),
});

const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("batch"), statements: z.array(statementSchema).min(1) }),
  z.object({ kind: z.literal("exec"), sql: z.string().min(1) }),
]);

type Statement = z.infer<typeof statementSchema>;

type E2ED1Environment = {
  DB: D1Database;
  E2E_D1_TOKEN?: string;
};

// Playwright fixtures send one SQL statement per call, so the bridge answers with the statement's
// native D1 result. Multi-statement calls use D1's atomic batch instead.
async function executeStatements(db: D1Database, statements: Statement[]) {
  if (statements.length > 1) {
    return db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
  }
  const [{ sql, params, mode }] = statements;
  const statement = db.prepare(sql).bind(...params);
  switch (mode) {
    case "first":
      return statement.first();
    case "run":
      return statement.run();
    case "raw":
      return statement.raw({ columnNames: true });
    default:
      return statement.all();
  }
}

function json(value: unknown, status = 200) {
  const body = JSON.stringify(value, (_key, item) =>
    item instanceof ArrayBuffer ? { __calflareBytes: Array.from(new Uint8Array(item)) } : item
  );
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

export async function handleE2eD1(request: Request, env: E2ED1Environment): Promise<Response | undefined> {
  if (!(typeof __CALFLARE_E2E_D1__ === "boolean" && __CALFLARE_E2E_D1__)) return undefined;
  if (request.method !== "POST" || new URL(request.url).pathname !== "/__e2e/d1") return undefined;
  const token = env.E2E_D1_TOKEN;
  if (!token || request.headers.get("x-e2e-d1-token") !== token) {
    return new Response("Not Found", { status: 404 });
  }
  try {
    const body = requestSchema.parse(await request.json());
    if (body.kind === "exec") return json(await env.DB.exec(body.sql));
    return json(await executeStatements(env.DB, body.statements));
  } catch (error) {
    return json({ error: { message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
