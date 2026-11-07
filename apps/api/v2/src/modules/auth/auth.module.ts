import { ApiKeysModule } from "@/modules/api-keys/api-keys.module";
import { ApiAuthGuard } from "@/modules/auth/guards/api-auth/api-auth.guard";
import { WebSessionGuard } from "@/modules/auth/guards/web-session/web-session.guard";
import { ApiAuthStrategy } from "@/modules/auth/strategies/api-auth/api-auth.strategy";
import { WebSessionStrategy } from "@/modules/auth/strategies/web-session/web-session.strategy";
import { CalWebSessionModule } from "@/modules/auth/services/cal-web-session.module";
import { DeploymentsModule } from "@/modules/deployments/deployments.module";
import { MembershipsModule } from "@/modules/memberships/memberships.module";
import { OAuthFlowService } from "@/modules/oauth-clients/services/oauth-flow.service";
import { RedisModule } from "@/modules/redis/redis.module";
import { TokensModule } from "@/modules/tokens/tokens.module";
import { UsersModule } from "@/modules/users/users.module";
import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";

@Module({
  imports: [
    PassportModule,
    CalWebSessionModule,
    RedisModule,
    ApiKeysModule,
    UsersModule,
    MembershipsModule,
    TokensModule,
    DeploymentsModule,
  ],
  providers: [WebSessionGuard, WebSessionStrategy, ApiAuthGuard, ApiAuthStrategy, OAuthFlowService],
  exports: [WebSessionGuard, ApiAuthGuard],
})
export class AuthModule {}
