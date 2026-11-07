import { WebSessionPassportStrategy } from "@/lib/passport/strategies/types";
import { CalWebSessionClient } from "@/modules/auth/services/cal-web-session.client";
import { UsersRepository } from "@/modules/users/users.repository";
import { Injectable, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";

@Injectable()
export class WebSessionStrategy extends PassportStrategy(WebSessionPassportStrategy, "web-session") {
  constructor(
    private readonly userRepository: UsersRepository,
    private readonly webSessionClient: CalWebSessionClient
  ) {
    super();
  }

  async authenticate(req: Request) {
    try {
      const session = await this.webSessionClient.getSession(req);

      if (!session) {
        throw new UnauthorizedException("WebSessionStrategy - Web session is missing or invalid.");
      }

      const user = await this.userRepository.findByEmailWithProfile(session.email);
      if (!user) {
        throw new UnauthorizedException(
          "WebSessionStrategy - User associated with the web session email not found."
        );
      }

      return this.success(user);
    } catch (error) {
      if (error instanceof Error) return this.error(error);
      return this.error(
        new InternalServerErrorException(
          "WebSessionStrategy - An error occurred while authenticating the request"
        )
      );
    }
  }
}
