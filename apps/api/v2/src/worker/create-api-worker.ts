import { withD1Database } from "@calcom/prisma/d1";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { WorkerEnv } from "./app";
import { createApiApp } from "./app";
import type { ModuleDefinition, ModuleScope } from "./metadata";
import { buildRouteTable } from "./metadata";

export interface ApiWorker {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response>;
}

export function createApiWorker({ modules }: { modules: readonly ModuleDefinition[] }): ApiWorker {
  const table = buildRouteTable(modules);
  const scopes = new Map<string, ModuleScope>(
    modules.map((module) => [module.key, module.create()] as const)
  );
  const scopeFor = (moduleKey: string): ModuleScope => {
    const scope = scopes.get(moduleKey);
    if (!scope) throw new Error(`Module ${moduleKey} is not composed`);
    return scope;
  };
  const app = createApiApp({ table, scopeFor });

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
      if (!env?.DB) throw new Error("Worker bindings are required");
      return withD1Database(env, () => app.fetch(request, env, ctx));
    },
  };
}
