import type { ModuleDefinition, ModuleScope } from "./metadata";
import { defineModule } from "./metadata";
import { AppController } from "@/app.controller";

export const healthModule: ModuleDefinition = defineModule({
  key: "health",
  controllers: [AppController],
  create(): ModuleScope {
    return { controllers: new Map([[AppController, new AppController()]]) };
  },
});

export const modules: readonly ModuleDefinition[] = [healthModule];
