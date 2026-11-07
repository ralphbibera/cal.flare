import { CalWebSessionClient } from "@/modules/auth/services/cal-web-session.client";
import { UsersRepository } from "@/modules/users/users.repository";
import { createMock } from "@golevelup/ts-jest";
import type { Request } from "express";
import { WebSessionStrategy } from "./web-session.strategy";

describe("WebSessionStrategy", () => {
  const request = { headers: { cookie: "better-auth.session_token=abc" } } as Request;
  let webSessionClient: CalWebSessionClient;
  let userRepository: UsersRepository;
  let strategy: WebSessionStrategy;
  let success: jest.Mock;
  let error: jest.Mock;

  beforeEach(() => {
    webSessionClient = createMock<CalWebSessionClient>();
    userRepository = createMock<UsersRepository>();
    strategy = new WebSessionStrategy(userRepository, webSessionClient);
    success = jest.fn();
    error = jest.fn();
    Object.assign(strategy, { success, error });
  });

  it("authenticates the user found by the session email", async () => {
    const user = { id: 7, email: "user@example.com" };
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue({ id: 7, email: user.email });
    const findByEmail = jest
      .spyOn(userRepository, "findByEmailWithProfile")
      .mockResolvedValue(user as Awaited<ReturnType<UsersRepository["findByEmailWithProfile"]>>);

    await strategy.authenticate(request);

    expect(findByEmail).toHaveBeenCalledWith("user@example.com");
    expect(success).toHaveBeenCalledWith(user);
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects a request without a web session", async () => {
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue(null);

    await strategy.authenticate(request);

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "WebSessionStrategy - Web session is missing or invalid." })
    );
  });

  it("rejects a session whose email has no user", async () => {
    jest.spyOn(webSessionClient, "getSession").mockResolvedValue({ id: 7, email: "gone@example.com" });
    jest.spyOn(userRepository, "findByEmailWithProfile").mockResolvedValue(null);

    await strategy.authenticate(request);

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "WebSessionStrategy - User associated with the web session email not found.",
      })
    );
  });
});
