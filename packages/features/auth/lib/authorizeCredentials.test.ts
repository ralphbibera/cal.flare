import process from "node:process";
import { IdentityProvider, UserPermissionRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "./ErrorCode";

vi.mock("@calcom/prisma", () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
  },
  default: {
    user: {
      update: vi.fn(),
    },
  },
}));

const mockFindByEmailAndIncludeProfilesAndPassword = vi.fn();

vi.mock("@calcom/features/users/repositories/UserRepository", () => {
  return {
    UserRepository: vi.fn().mockImplementation(function () {
      return {
        findByEmailAndIncludeProfilesAndPassword: mockFindByEmailAndIncludeProfilesAndPassword,
      };
    }),
  };
});

vi.mock("./verifyPassword", () => ({
  verifyPassword: vi.fn(),
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@calcom/lib/server/PiiHasher", () => ({
  hashEmail: vi.fn((email: string) => `hashed_${email}`),
}));

vi.mock("@calcom/lib/totp", () => ({
  totpAuthenticatorCheck: vi.fn(),
}));

vi.mock("@calcom/lib/crypto", () => ({
  symmetricDecrypt: vi.fn(),
  symmetricEncrypt: vi.fn(),
}));

vi.mock("@calcom/lib/auth/isPasswordValid", () => ({
  isPasswordValid: vi.fn(),
}));

vi.mock("@calcom/lib/env", () => ({
  isENVDev: false,
}));

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return {
    ...actual,
    IS_TEAM_BILLING_ENABLED: false,
    ENABLE_PROFILE_SWITCHER: false,
    WEBAPP_URL: "http://localhost:3000",
  };
});

vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock("@calcom/lib/safeStringify", () => ({
  safeStringify: vi.fn((obj) => JSON.stringify(obj)),
}));

describe("authorizeCredentials", () => {
  let authorizeCredentials: typeof import("./authorizeCredentials").authorizeCredentials;
  let verifyPassword: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindByEmailAndIncludeProfilesAndPassword.mockReset();

    const verifyPasswordModule = await import("./verifyPassword");
    verifyPassword = verifyPasswordModule.verifyPassword;

    const authModule = await import("./authorizeCredentials");
    authorizeCredentials = authModule.authorizeCredentials;
  });

  const createMockUser = (overrides: Partial<any> = {}) => ({
    id: 1,
    email: "test@example.com",
    name: "Test User",
    username: "testuser",
    role: UserPermissionRole.USER,
    locked: false,
    identityProvider: IdentityProvider.CAL,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    backupCodes: null,
    password: {
      hash: "$2a$10$hashedpassword",
    },
    allProfiles: [
      {
        id: 1,
        upId: "usr_123",
        username: "testuser",
      },
    ],
    teams: [],
    ...overrides,
  });

  describe("Password validation", () => {
    it("should throw error when user has no password hash with CAL identity provider", async () => {
      const mockUser = createMockUser({
        password: null,
        identityProvider: IdentityProvider.CAL,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      await expect(
        authorizeCredentials({
          email: "test@example.com",
          password: "password123",
        } as any)
      ).rejects.toThrow(ErrorCode.IncorrectEmailPassword);
    });

    it("should throw error when user has no password hash with Google identity provider", async () => {
      const mockUser = createMockUser({
        password: null,
        identityProvider: IdentityProvider.GOOGLE,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      await expect(
        authorizeCredentials({
          email: "test@example.com",
          password: "password123",
        } as any)
      ).rejects.toThrow(ErrorCode.IncorrectEmailPassword);
    });

    it("should throw error when user has no password hash with SAML identity provider", async () => {
      const mockUser = createMockUser({
        password: null,
        identityProvider: IdentityProvider.SAML,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      await expect(
        authorizeCredentials({
          email: "test@example.com",
          password: "password123",
        } as any)
      ).rejects.toThrow(ErrorCode.IncorrectEmailPassword);
    });

    it("should throw error when user has no password hash even with TOTP code provided", async () => {
      const mockUser = createMockUser({
        password: null,
        identityProvider: IdentityProvider.CAL,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      await expect(
        authorizeCredentials({
          email: "test@example.com",
          password: "password123",
          totpCode: "123456",
        } as any)
      ).rejects.toThrow(ErrorCode.IncorrectEmailPassword);
    });

    it("should throw error when user has no password hash with Google identity provider and TOTP code", async () => {
      const mockUser = createMockUser({
        password: null,
        identityProvider: IdentityProvider.GOOGLE,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      await expect(
        authorizeCredentials({
          email: "test@example.com",
          password: "password123",
          totpCode: "123456",
        } as any)
      ).rejects.toThrow(ErrorCode.IncorrectEmailPassword);
    });

    it("should throw error when user has no password hash with SAML identity provider and TOTP code", async () => {
      const mockUser = createMockUser({
        password: null,
        identityProvider: IdentityProvider.SAML,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      await expect(
        authorizeCredentials({
          email: "test@example.com",
          password: "password123",
          totpCode: "123456",
        } as any)
      ).rejects.toThrow(ErrorCode.IncorrectEmailPassword);
    });
  });

  describe("Locked account", () => {
    it("rejects a locked user before verifying the password", async () => {
      const { verifyPassword } = await import("./verifyPassword");
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(
        createMockUser({ locked: true }) as never
      );

      await expect(
        authorizeCredentials({
          email: "test@example.com",
          password: "password123",
        } as any)
      ).rejects.toThrow(ErrorCode.UserAccountLocked);
      expect(verifyPassword).not.toHaveBeenCalled();
    });
  });

  describe("Inactive admin reason", () => {
    it("sets reason to 'both' when password is invalid and 2FA is disabled", async () => {
      const { isPasswordValid } = await import("@calcom/lib/auth/isPasswordValid");
      vi.mocked(isPasswordValid).mockReturnValue(false);
      vi.mocked(verifyPassword).mockResolvedValue(true);

      const mockUser = createMockUser({
        role: UserPermissionRole.ADMIN,
        identityProvider: IdentityProvider.CAL,
        twoFactorEnabled: false,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      const result = await authorizeCredentials({
        email: mockUser.email,
        password: "password123",
        totpCode: "",
        backupCode: "",
      });

      expect(result?.role).toBe("INACTIVE_ADMIN");
      expect(result?.inactiveAdminReason).toBe("both");
    });

    it("sets reason to '2fa' when password is valid and 2FA is disabled", async () => {
      const { isPasswordValid } = await import("@calcom/lib/auth/isPasswordValid");
      vi.mocked(isPasswordValid).mockReturnValue(true);
      vi.mocked(verifyPassword).mockResolvedValue(true);

      const mockUser = createMockUser({
        role: UserPermissionRole.ADMIN,
        identityProvider: IdentityProvider.CAL,
        twoFactorEnabled: false,
      });
      mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

      const result = await authorizeCredentials({
        email: mockUser.email,
        password: "password123",
        totpCode: "",
        backupCode: "",
      });

      expect(result?.role).toBe("INACTIVE_ADMIN");
      expect(result?.inactiveAdminReason).toBe("2fa");
    });

    it("sets reason to 'password' when password is invalid and 2FA is enabled", async () => {
      const originalKey = process.env.CALENDSO_ENCRYPTION_KEY;
      process.env.CALENDSO_ENCRYPTION_KEY = "test";

      try {
        const { isPasswordValid } = await import("@calcom/lib/auth/isPasswordValid");
        vi.mocked(isPasswordValid).mockReturnValue(false);
        vi.mocked(verifyPassword).mockResolvedValue(true);

        const { symmetricDecrypt } = await import("@calcom/lib/crypto");
        vi.mocked(symmetricDecrypt).mockReturnValue("a".repeat(32));

        const { totpAuthenticatorCheck } = await import("@calcom/lib/totp");
        vi.mocked(totpAuthenticatorCheck).mockReturnValue(true);

        const mockUser = createMockUser({
          role: UserPermissionRole.ADMIN,
          identityProvider: IdentityProvider.CAL,
          twoFactorEnabled: true,
          twoFactorSecret: "encrypted_secret",
        });
        mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

        const result = await authorizeCredentials({
          email: mockUser.email,
          password: "password123",
          totpCode: "123456",
          backupCode: "",
        });

        expect(result?.role).toBe("INACTIVE_ADMIN");
        expect(result?.inactiveAdminReason).toBe("password");
      } finally {
        process.env.CALENDSO_ENCRYPTION_KEY = originalKey;
      }
    });

    it("does not set inactiveAdminReason when admin requirements are met", async () => {
      const originalKey = process.env.CALENDSO_ENCRYPTION_KEY;
      process.env.CALENDSO_ENCRYPTION_KEY = "test";

      try {
        const { isPasswordValid } = await import("@calcom/lib/auth/isPasswordValid");
        vi.mocked(isPasswordValid).mockReturnValue(true);
        vi.mocked(verifyPassword).mockResolvedValue(true);

        const { symmetricDecrypt } = await import("@calcom/lib/crypto");
        vi.mocked(symmetricDecrypt).mockReturnValue("a".repeat(32));

        const { totpAuthenticatorCheck } = await import("@calcom/lib/totp");
        vi.mocked(totpAuthenticatorCheck).mockReturnValue(true);

        const mockUser = createMockUser({
          role: UserPermissionRole.ADMIN,
          identityProvider: IdentityProvider.CAL,
          twoFactorEnabled: true,
          twoFactorSecret: "encrypted_secret",
        });
        mockFindByEmailAndIncludeProfilesAndPassword.mockResolvedValue(mockUser);

        const result = await authorizeCredentials({
          email: mockUser.email,
          password: "password123",
          totpCode: "123456",
          backupCode: "",
        });

        expect(result?.role).toBe(UserPermissionRole.ADMIN);
        expect(result?.inactiveAdminReason).toBeUndefined();
      } finally {
        process.env.CALENDSO_ENCRYPTION_KEY = originalKey;
      }
    });
  });
});
