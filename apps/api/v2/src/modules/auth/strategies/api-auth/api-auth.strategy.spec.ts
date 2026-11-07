import { AuthMethods } from "@/lib/enums/auth-methods";
import { ApiKeysRepository } from "@/modules/api-keys/api-keys-repository";
import { CalWebSessionClient } from "@/modules/auth/services/cal-web-session.client";
import { MembershipsRepository } from "@/modules/memberships/memberships.repository";
import { OAuthClientRepository } from "@/modules/oauth-clients/oauth-client.repository";
import { OAuthFlowService } from "@/modules/oauth-clients/services/oauth-flow.service";
import { TokensRepository } from "@/modules/tokens/tokens.repository";
import { TokensService } from "@/modules/tokens/tokens.service";
import { UsersService } from "@/modules/users/services/users.service";
import { UsersRepository } from "@/modules/users/users.repository";
import { createMock } from "@golevelup/ts-jest";
import { ConfigService } from "@nestjs/config";
import type { AllowedAuthMethod } from "../../decorators/api-auth-guard-only-allow.decorator";
import { type ApiAuthGuardRequest, ApiAuthStrategy, NO_AUTH_PROVIDED_MESSAGE } from "./api-auth.strategy";

describe("ApiAuthStrategy web session", () => {
  const session = { id: 7, email: "user@example.com" };
  const user = { id: 7, email: session.email, role: "USER", profiles: [] };
  let webSessionClient: CalWebSessionClient;
  let userRepository: UsersRepository;
  let strategy: ApiAuthStrategy;
  let success: jest.Mock;
  let error: jest.Mock;

  function buildRequest(
    options: { allowedAuthMethods?: AllowedAuthMethod[]; bearer?: string } = {}
  ): ApiAuthGuardRequest {
    const headers: Record<string, string> = { cookie: "better-auth.session_token=abc" };
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    return {
      params: {},
      headers,
      allowedAuthMethods: options.allowedAuthMethods,
      get: (name: string) => headers[name.toLowerCase()],
    } as unknown as ApiAuthGuardRequest;
  }

  beforeEach(() => {
    webSessionClient = createMock<CalWebSessionClient>();
    userRepository = createMock<UsersRepository>();
    jest.spyOn(userRepository, "findByEmailWithProfile").mockResolvedValue(user as never);
    strategy = new ApiAuthStrategy(
      createMock<ConfigService>(),
      createMock<OAuthFlowService>(),
      createMock<TokensRepository>(),
      createMock<TokensService>(),
      userRepository,
      createMock<ApiKeysRepository>(),
      createMock<OAuthClientRepository>(),
      createMock<UsersService>({ getUserMainOrgId: jest.fn().mockReturnValue(null) }),
      createMock<MembershipsRepository>(),
      webSessionClient
    );
    success = jest.fn();
    error = jest.fn();
    Object.assign(strategy, { success, error });
  });

  it("authenticates a web session when any method is allowed", async () => {
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue(session);
    const request = buildRequest();

    await strategy.authenticate(request);

    expect(request.authMethod).toBe(AuthMethods.WEB_SESSION);
    expect(userRepository.findByEmailWithProfile).toHaveBeenCalledWith(session.email);
    expect(success).toHaveBeenCalledWith(expect.objectContaining({ id: 7, isSystemAdmin: false }));
  });

  it("authenticates a web session when WEB_SESSION is explicitly allowed", async () => {
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue(session);

    await strategy.authenticate(buildRequest({ allowedAuthMethods: ["WEB_SESSION"] }));

    expect(success).toHaveBeenCalled();
  });

  it("ignores a web session on a route that does not allow it", async () => {
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue(session);

    await strategy.authenticate(buildRequest({ allowedAuthMethods: ["API_KEY"] }));

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "Invalid authentication method. Please provide one of the allowed methods: API_KEY"
        ),
      })
    );
  });

  it("does not look up the session when a bearer token is present", async () => {
    const getSession = jest.spyOn(webSessionClient, "getSession").mockResolvedValue(session);

    await strategy.authenticate(
      buildRequest({ bearer: "not-a-valid-token", allowedAuthMethods: ["WEB_SESSION"] })
    );

    expect(getSession).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("rejects a session whose email has no user", async () => {
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue(session);
    jest.spyOn(userRepository, "findByEmailWithProfile").mockResolvedValue(null);

    await strategy.authenticate(buildRequest());

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ApiAuthStrategy - web session - User associated with the web session email not found.",
      })
    );
  });

  it("reports missing authentication when there is no session", async () => {
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue(null);

    await strategy.authenticate(buildRequest());

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: `ApiAuthStrategy - ${NO_AUTH_PROVIDED_MESSAGE}` })
    );
  });
});
