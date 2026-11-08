import "reflect-metadata";

import { modules } from "./worker/composition";
import type { ApiWorker } from "./worker/create-api-worker";
import { createApiWorker } from "./worker/create-api-worker";

const worker: ApiWorker = createApiWorker({ modules });

export default worker;

// biome-ignore lint/style/noRestrictedImports: the web Worker binds this Durable Object class to calflare-api-v2
export { RuntimeState } from "@calcom/lib/RuntimeState";
