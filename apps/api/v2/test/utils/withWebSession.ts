import { WebSessionStrategy } from "@/modules/auth/strategies/web-session/web-session.strategy";
import { UsersRepository } from "@/modules/users/users.repository";
import { TestingModuleBuilder } from "@nestjs/testing";
import { WebSessionMockStrategy } from "test/mocks/web-session-mock.strategy";

export const withWebSession = (email: string, module: TestingModuleBuilder) =>
  module.overrideProvider(WebSessionStrategy).useFactory({
    factory: (userRepository: UsersRepository) => new WebSessionMockStrategy(email, userRepository),
    inject: [UsersRepository],
  });
