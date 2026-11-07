import { CalWebSessionClient } from "@/modules/auth/services/cal-web-session.client";
import { Global, Module } from "@nestjs/common";

@Global()
@Module({
  providers: [CalWebSessionClient],
  exports: [CalWebSessionClient],
})
export class CalWebSessionModule {}
