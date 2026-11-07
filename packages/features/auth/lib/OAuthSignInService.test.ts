import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthSignInService } from "./OAuthSignInService";

// The lookup runs against real D1 in its integration test; here findFirst decides which user exists.
vi.mock("@calcom/features/auth/lib/findUserIdByInsensitiveField", () => ({
  findUserIdByInsensitiveField: vi.fn().mockResolvedValue(1),
}));
vi.mock("@calcom/prisma", () => ({
  prisma: { user: { update: vi.fn() } },
  default: { user: { update: vi.fn() } },
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

const mockCredentialRepoFindFirst = vi.fn();
const mockCredentialRepoFindFirstByUserIdAndType = vi.fn();
const mockCredentialRepoCreate = vi.fn();
const mockBuildCredentialCreateData = vi.fn();
const mockUpdateProfilePhotoMicrosoft = vi.fn();
const mockUpdateProfilePhotoGoogle = vi.fn();
const mockGetIdentityProvider = vi.fn();
const mockPrismaUserFindFirst = vi.fn();
const mockPrismaUserCreate = vi.fn();
const mockPrismaUserUpdate = vi.fn();
const mockPrismaTeamFindFirst = vi.fn();
const mockPrismaSelectedCalendarCreate = vi.fn();
const mockPrismaAccountCreate = vi.fn();

vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: {
    findFirstByAppIdAndUserId: (...args: unknown[]) => mockCredentialRepoFindFirst(...args),
    findFirstByUserIdAndType: (...args: unknown[]) => mockCredentialRepoFindFirstByUserIdAndType(...args),
    create: (...args: unknown[]) => mockCredentialRepoCreate(...args),
  },
}));

vi.mock("@calcom/features/credentials/services/CredentialDataService", () => ({
  buildCredentialCreateData: (...args: unknown[]) => mockBuildCredentialCreateData(...args),
}));

vi.mock("@calcom/app-store/_utils/oauth/updateProfilePhotoMicrosoft", () => ({
  updateProfilePhotoMicrosoft: (...args: unknown[]) => mockUpdateProfilePhotoMicrosoft(...args),
}));

vi.mock("@calcom/app-store/_utils/oauth/updateProfilePhotoGoogle", () => ({
  updateProfilePhotoGoogle: (...args: unknown[]) => mockUpdateProfilePhotoGoogle(...args),
}));

vi.mock("@calcom/features/auth/lib/identityProviders", () => ({
  getIdentityProvider: (...args: unknown[]) => mockGetIdentityProvider(...args),
}));

vi.mock("@calcom/lib/random", () => ({
  randomString: vi.fn(() => "abc123"),
}));

vi.mock("@calcom/lib/slugify", () => ({
  default: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, "-")),
}));

vi.mock("@calcom/app-store/googlecalendar/lib/CalendarService", () => ({
  createGoogleCalendarServiceWithGoogleType: vi.fn(),
}));

vi.mock("googleapis-common", () => ({
  OAuth2Client: vi.fn(),
}));

vi.mock("@googleapis/calendar", () => ({
  calendar_v3: {
    Calendar: vi.fn(),
  },
}));

vi.mock("./signJwt", () => ({
  default: vi.fn().mockResolvedValue("mock-jwt"),
}));

vi.mock("../signup/utils/getOrgUsernameFromEmail", () => ({
  getOrgUsernameFromEmail: vi.fn((email: string) => email.split("@")[0]),
}));

describe("Azure AD signIn callback", () => {
  let service: OAuthSignInService;
  const signInCallback = (params: Parameters<OAuthSignInService["signIn"]>[0]) => service.signIn(params);

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetIdentityProvider.mockImplementation((provider: string) => {
      const map: Record<string, string> = {
        "azure-ad": "AZUREAD",
        google: "GOOGLE",
        saml: "SAML",
        "saml-idp": "SAML",
        cal: "CAL",
      };
      return map[provider] ?? null;
    });

    // Mock prisma methods used in signIn callback
    const prismaModule = await import("@calcom/prisma");
    const prismaDefault = (prismaModule as any).default;
    prismaDefault.user = {
      ...prismaDefault.user,
      findFirst: mockPrismaUserFindFirst,
      create: mockPrismaUserCreate,
      update: mockPrismaUserUpdate,
    };
    prismaDefault.team = {
      findFirst: mockPrismaTeamFindFirst,
    };
    prismaDefault.selectedCalendar = {
      create: mockPrismaSelectedCalendarCreate,
    };
    prismaDefault.account = { create: mockPrismaAccountCreate };

    mockPrismaUserFindFirst.mockResolvedValue(null);
    mockPrismaUserCreate.mockResolvedValue({ id: 100, email: "new@example.com", twoFactorEnabled: false });
    mockPrismaUserUpdate.mockResolvedValue({});
    mockPrismaTeamFindFirst.mockResolvedValue(null);
    mockUpdateProfilePhotoMicrosoft.mockResolvedValue(undefined);

    mockPrismaAccountCreate.mockResolvedValue({ id: "account-1" });

    const { OAuthSignInService: Service } = await import("./OAuthSignInService");
    service = new Service();
  });

  describe("Azure AD email verification (xms_edov)", () => {
    const baseParams = {
      user: { id: "1", email: "user@example.com", name: "User", emailVerified: null },
      account: {
        provider: "azure-ad",
        providerAccountId: "azure-123",
        type: "oauth" as const,
      },
      credentials: undefined,
      email: undefined,
    };

    it("allows login when xms_edov is true (boolean)", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        accounts: [{ provider: "azure-ad" }],
        twoFactorEnabled: false,
        identityProvider: "AZUREAD",
      });

      const result = await signInCallback({
        ...baseParams,
        profile: { email_verified: false, xms_edov: true } as any,
      } as any);

      expect(result).toMatchObject({ kind: "allow" });
    });

    it("allows login when xms_edov is string 'true'", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        accounts: [{ provider: "azure-ad" }],
        twoFactorEnabled: false,
        identityProvider: "AZUREAD",
      });

      const result = await signInCallback({
        ...baseParams,
        profile: { xms_edov: "true" } as any,
      } as any);

      expect(result).toMatchObject({ kind: "allow" });
    });

    it("allows login when xms_edov is string '1'", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        accounts: [{ provider: "azure-ad" }],
        twoFactorEnabled: false,
        identityProvider: "AZUREAD",
      });

      const result = await signInCallback({
        ...baseParams,
        profile: { xms_edov: "1" } as any,
      } as any);

      expect(result).toMatchObject({ kind: "allow" });
    });

    it("allows login when xms_edov is number 1", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        accounts: [{ provider: "azure-ad" }],
        twoFactorEnabled: false,
        identityProvider: "AZUREAD",
      });

      const result = await signInCallback({
        ...baseParams,
        profile: { xms_edov: 1 } as any,
      } as any);

      expect(result).toMatchObject({ kind: "allow" });
    });

    it("rejects login when xms_edov is false", async () => {
      const result = await signInCallback({
        ...baseParams,
        profile: { xms_edov: false } as any,
      } as any);

      expect(result).toEqual({ kind: "redirect", to: "/auth/error?error=unverified-email" });
    });

    it("rejects login when xms_edov is undefined", async () => {
      const result = await signInCallback({
        ...baseParams,
        profile: {} as any,
      } as any);

      expect(result).toEqual({ kind: "redirect", to: "/auth/error?error=unverified-email" });
    });

    it("rejects login when xms_edov is 0", async () => {
      const result = await signInCallback({
        ...baseParams,
        profile: { xms_edov: 0 } as any,
      } as any);

      expect(result).toEqual({ kind: "redirect", to: "/auth/error?error=unverified-email" });
    });

    it("rejects login when xms_edov is string '0'", async () => {
      const result = await signInCallback({
        ...baseParams,
        profile: { xms_edov: "0" } as any,
      } as any);

      expect(result).toEqual({ kind: "redirect", to: "/auth/error?error=unverified-email" });
    });

    it("allows non-AZUREAD with email_verified=true", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        accounts: [{ provider: "google" }],
        twoFactorEnabled: false,
        identityProvider: "GOOGLE",
      });

      const result = await signInCallback({
        user: { id: "1", email: "user@example.com", name: "User", emailVerified: null },
        account: { provider: "google", providerAccountId: "google-123", type: "oauth" as const },
        profile: { email_verified: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      expect(result).toMatchObject({ kind: "allow" });
    });

    it("rejects non-AZUREAD with email_verified=false", async () => {
      const result = await signInCallback({
        user: { id: "1", email: "user@example.com", name: "User", emailVerified: null },
        account: { provider: "google", providerAccountId: "google-123", type: "oauth" as const },
        profile: { email_verified: false } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      expect(result).toEqual({ kind: "redirect", to: "/auth/error?error=unverified-email" });
    });
  });

  describe("Azure AD profile photo on new user (signIn callback)", () => {
    const baseUser = { id: "1", email: "newuser@example.com", name: "New User", emailVerified: null };

    it("calls updateProfilePhotoMicrosoft for new Azure AD user with access_token", async () => {
      // No existing user
      mockPrismaUserFindFirst.mockResolvedValue(null);
      mockPrismaUserCreate.mockResolvedValue({
        id: 100,
        email: "newuser@example.com",
        twoFactorEnabled: false,
      });

      await signInCallback({
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-new-123",
          type: "oauth" as const,
          access_token: "new-user-token",
        },
        profile: { xms_edov: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      expect(mockUpdateProfilePhotoMicrosoft).toHaveBeenCalledWith("new-user-token", 100);
    });

    it("skips updateProfilePhotoMicrosoft for new Azure AD user without access_token", async () => {
      mockPrismaUserFindFirst.mockResolvedValue(null);
      mockPrismaUserCreate.mockResolvedValue({
        id: 101,
        email: "newuser@example.com",
        twoFactorEnabled: false,
      });

      await signInCallback({
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-new-456",
          type: "oauth" as const,
        },
        profile: { xms_edov: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      expect(mockUpdateProfilePhotoMicrosoft).not.toHaveBeenCalled();
    });

    it("skips updateProfilePhotoMicrosoft for new Google user", async () => {
      mockPrismaUserFindFirst.mockResolvedValue(null);
      mockPrismaUserCreate.mockResolvedValue({
        id: 102,
        email: "newuser@example.com",
        twoFactorEnabled: false,
      });

      await signInCallback({
        user: baseUser,
        account: {
          provider: "google",
          providerAccountId: "google-new-789",
          type: "oauth" as const,
          access_token: "google-token",
        },
        profile: { email_verified: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      expect(mockUpdateProfilePhotoMicrosoft).not.toHaveBeenCalled();
    });

    it("photo update failure does not crash signup", async () => {
      mockPrismaUserFindFirst.mockResolvedValue(null);
      mockPrismaUserCreate.mockResolvedValue({
        id: 103,
        email: "newuser@example.com",
        twoFactorEnabled: false,
      });
      mockUpdateProfilePhotoMicrosoft.mockRejectedValue(new Error("Photo update failed"));

      const result = await signInCallback({
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-fail-123",
          type: "oauth" as const,
          access_token: "fail-token",
        },
        profile: { xms_edov: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      // Should still return something (true or error redirect), not throw
      expect(result).toBeDefined();
    });
  });

  describe("Azure AD identity provider conversion (signIn callback)", () => {
    it("CAL user with verified email converts to AZUREAD on Azure AD login", async () => {
      // No existing user with AZUREAD identity
      mockPrismaUserFindFirst
        .mockResolvedValueOnce(null) // First call: lookup by identityProvider + providerAccountId
        .mockResolvedValueOnce(null) // Legacy lookup
        .mockResolvedValueOnce({
          // Lookup by email
          id: 50,
          email: "user@example.com",
          emailVerified: new Date(),
          identityProvider: "CAL",
          password: { hash: "hashed" },
          twoFactorEnabled: false,
        });

      const result = await signInCallback({
        user: { id: "1", email: "user@example.com", name: "User", emailVerified: null },
        account: { provider: "azure-ad", providerAccountId: "azure-conv-1", type: "oauth" as const },
        profile: { xms_edov: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      expect(mockPrismaUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            identityProvider: "AZUREAD",
            identityProviderId: "azure-conv-1",
          }),
        })
      );
      expect(result).toMatchObject({ kind: "allow" });
    });

    it("GOOGLE user auto-merges on Azure AD login when email is verified", async () => {
      mockPrismaUserFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 51,
        email: "user@example.com",
        emailVerified: new Date(),
        identityProvider: "GOOGLE",
        password: null,
        twoFactorEnabled: false,
      });

      const result = await signInCallback({
        user: { id: "1", email: "user@example.com", name: "User", emailVerified: null },
        account: { provider: "azure-ad", providerAccountId: "azure-conv-2", type: "oauth" as const },
        profile: { xms_edov: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      // With isVerified=true and non-CAL provider, auto-merge path is taken (returns true directly)
      expect(result).toMatchObject({ kind: "allow" });
    });

    it("AZUREAD user auto-merges on Google login when email is verified", async () => {
      mockPrismaUserFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 52,
        email: "user@example.com",
        emailVerified: new Date(),
        identityProvider: "AZUREAD",
        password: null,
        twoFactorEnabled: false,
      });

      const result = await signInCallback({
        user: { id: "1", email: "user@example.com", name: "User", emailVerified: null },
        account: { provider: "google", providerAccountId: "google-conv-1", type: "oauth" as const },
        profile: { email_verified: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      // With isVerified=true and non-CAL provider, auto-merge path is taken (returns true directly)
      expect(result).toMatchObject({ kind: "allow" });
    });

    it("unverified CAL account blocks Azure AD linking (anti-hijack)", async () => {
      mockPrismaUserFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 53,
          email: "user@example.com",
          emailVerified: null,
          identityProvider: "CAL",
          password: { hash: "hashed" },
          twoFactorEnabled: false,
        });

      const result = await signInCallback({
        user: { id: "1", email: "user@example.com", name: "User", emailVerified: null },
        account: { provider: "azure-ad", providerAccountId: "azure-hijack-1", type: "oauth" as const },
        profile: { xms_edov: true } as any,
        credentials: undefined,
        email: undefined,
      } as any);

      expect(result).toEqual({ kind: "redirect", to: "/auth/error?error=unverified-email" });
    });
  });
});

describe("Azure AD JWT callback", () => {
  let service: OAuthSignInService;
  const jwtCallback = (params: {
    user: { id: string; email?: string | null };
    account: Parameters<OAuthSignInService["installDefaultCalendars"]>[0]["account"];
  }) =>
    service.installDefaultCalendars({
      userId: Number(params.user.id),
      email: params.user.email,
      account: params.account,
    });
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    mockGetIdentityProvider.mockImplementation((provider: string) => {
      const map: Record<string, string> = {
        "azure-ad": "AZUREAD",
        google: "GOOGLE",
        saml: "SAML",
        "saml-idp": "SAML",
        cal: "CAL",
      };
      return map[provider] ?? null;
    });
    mockCredentialRepoCreate.mockResolvedValue({ id: 1 });
    mockBuildCredentialCreateData.mockImplementation((data: any) => data);
    mockUpdateProfilePhotoMicrosoft.mockResolvedValue(undefined);

    // Setup prisma mocks
    const prismaModule = await import("@calcom/prisma");
    const prismaDefault = (prismaModule as any).default;
    prismaDefault.user = {
      ...prismaDefault.user,
      findFirst: mockPrismaUserFindFirst,
    };
    prismaDefault.selectedCalendar = {
      create: mockPrismaSelectedCalendarCreate,
    };

    mockPrismaSelectedCalendarCreate.mockResolvedValue({});

    const { OAuthSignInService: Service } = await import("./OAuthSignInService");
    service = new Service();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Azure AD calendar auto-install", () => {
    const baseToken = { sub: "1", email: "user@example.com", upId: "usr_1" } as any;
    const baseUser = {
      id: "1",
      email: "user@example.com",
      name: "Test",
      username: "test",
      role: "USER",
      locale: "en",
    } as any;

    it("creates office365-calendar credential on first login with all scopes", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ value: [{ id: "cal-id-1", isDefaultCalendar: true }] }),
      }) as unknown as typeof fetch;

      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "at-123",
          refresh_token: "rt-123",
          expires_at: 1700000000,
          scope: "User.Read Calendars.Read Calendars.ReadWrite offline_access",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockBuildCredentialCreateData).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "office365-calendar",
          type: "office365_calendar",
        })
      );
      expect(mockCredentialRepoCreate).toHaveBeenCalled();
    });

    it("skips creation when office365-calendar credential already exists", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue({ id: 99 });

      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "at-123",
          scope: "User.Read Calendars.Read Calendars.ReadWrite",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockBuildCredentialCreateData).not.toHaveBeenCalledWith(
        expect.objectContaining({ appId: "office365-calendar" })
      );
    });

    it("skips creation when calendar scopes are missing", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue(null);

      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "at-123",
          scope: "User.Read",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockCredentialRepoCreate).not.toHaveBeenCalled();
    });

    it("offline_access is excluded from scope check", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ value: [] }),
      }) as unknown as typeof fetch;

      // Scope without offline_access — should still pass scope check
      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "at-123",
          scope: "User.Read Calendars.Read Calendars.ReadWrite",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockCredentialRepoCreate).toHaveBeenCalled();
    });

    it("fetches default calendar and creates selectedCalendar", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue(null);
      mockCredentialRepoCreate.mockResolvedValue({ id: 77 });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            value: [
              { id: "non-default-cal", isDefaultCalendar: false },
              { id: "default-cal-id", isDefaultCalendar: true },
            ],
          }),
      }) as unknown as typeof fetch;

      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "at-123",
          scope: "User.Read Calendars.Read Calendars.ReadWrite",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockPrismaSelectedCalendarCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          integration: "office365_calendar",
          externalId: "default-cal-id",
          credentialId: 77,
        }),
      });
    });

    it("Graph API fetch failure logs error but does not crash", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;

      // Should not throw
      const installed = jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "at-123",
          scope: "User.Read Calendars.Read Calendars.ReadWrite",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      await expect(installed).resolves.toBeUndefined();
    });

    it("calls updateProfilePhotoMicrosoft after calendar install", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ value: [] }),
      }) as unknown as typeof fetch;

      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "photo-token",
          scope: "User.Read Calendars.Read Calendars.ReadWrite",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockUpdateProfilePhotoMicrosoft).toHaveBeenCalledWith("photo-token", 1);
    });

    it("calls updateProfilePhotoMicrosoft even when calendar already installed (else-if branch)", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      // Calendar credential already exists
      mockCredentialRepoFindFirst.mockResolvedValue({ id: 99 });

      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "photo-token-2",
          scope: "User.Read Calendars.Read Calendars.ReadWrite",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockUpdateProfilePhotoMicrosoft).toHaveBeenCalledWith("photo-token-2", 1);
    });

    it("converts expires_at from seconds to milliseconds in credential key", async () => {
      mockPrismaUserFindFirst.mockResolvedValue({
        id: 1,
        email: "user@example.com",
        name: "Test",
        username: "test",
        role: "USER",
        locale: "en",
        avatarUrl: null,
        identityProvider: "AZUREAD",
        identityProviderId: "azure-123",
        teams: [],
        movedToProfileId: null,
      });
      mockCredentialRepoFindFirst.mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ value: [] }),
      }) as unknown as typeof fetch;

      const expiresAtSeconds = 1700000000;

      await jwtCallback({
        token: baseToken,
        user: baseUser,
        account: {
          provider: "azure-ad",
          providerAccountId: "azure-123",
          type: "oauth",
          access_token: "at-123",
          refresh_token: "rt-123",
          expires_at: expiresAtSeconds,
          scope: "User.Read Calendars.Read Calendars.ReadWrite",
        },
        trigger: undefined,
        session: undefined,
      } as any);

      expect(mockBuildCredentialCreateData).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.objectContaining({
            expiry_date: expiresAtSeconds * 1000,
          }),
        })
      );
    });
  });
});

describe("OAuth sign-in completion", () => {
  let service: OAuthSignInService;
  const user = { id: "azure-sub", email: "user@example.com", name: "User" };
  const account = {
    provider: "azure-ad",
    providerAccountId: "azure-complete-1",
    type: "oauth",
    access_token: "at",
    scope: "User.Read",
  };
  const mockPrismaAccountFindUnique = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetIdentityProvider.mockReturnValue("AZUREAD");
    const prismaModule = await import("@calcom/prisma");
    const prismaDefault = (prismaModule as any).default;
    prismaDefault.user = {
      ...prismaDefault.user,
      findFirst: mockPrismaUserFindFirst,
      create: mockPrismaUserCreate,
    };
    prismaDefault.team = { findFirst: mockPrismaTeamFindFirst };
    prismaDefault.account = { create: mockPrismaAccountCreate, findUnique: mockPrismaAccountFindUnique };
    mockPrismaUserFindFirst.mockResolvedValue(null);
    mockPrismaTeamFindFirst.mockResolvedValue(null);
    mockPrismaAccountFindUnique.mockResolvedValue(null);
    mockPrismaAccountCreate.mockResolvedValue({ id: "account-1" });
    mockPrismaUserCreate.mockResolvedValue({ id: 100, email: user.email, twoFactorEnabled: false });
    mockUpdateProfilePhotoMicrosoft.mockResolvedValue(undefined);
    mockCredentialRepoFindFirst.mockResolvedValue({ id: 1 });
    const { OAuthSignInService: Service } = await import("./OAuthSignInService");
    service = new Service();
  });

  it("names the created user in the allow decision", async () => {
    const decision = await service.signIn({ user, account, profile: { xms_edov: true } });

    expect(decision).toEqual({ kind: "allow", userId: 100 });
  });

  it("links the provider account for a user that has none", async () => {
    mockPrismaUserFindFirst.mockResolvedValue({ id: 7 });

    await service.completeSignIn({ userId: 7, user, account });

    expect(mockPrismaAccountCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "azure-ad",
          providerAccountId: "azure-complete-1",
          access_token: "at",
          user: { connect: { id: 7 } },
        }),
      })
    );
  });

  it("keeps an existing provider account link", async () => {
    mockPrismaAccountFindUnique.mockResolvedValue({ id: "account-9" });
    mockPrismaUserFindFirst.mockResolvedValue({ id: 7 });

    await service.completeSignIn({ userId: 7, user, account });

    expect(mockPrismaAccountCreate).not.toHaveBeenCalled();
  });

  it("refreshes the Microsoft photo only for a user tied to the provider id", async () => {
    mockPrismaUserFindFirst.mockResolvedValueOnce({ id: 7 });
    await service.completeSignIn({ userId: 7, user, account });
    expect(mockUpdateProfilePhotoMicrosoft).toHaveBeenCalledWith("at", 7);

    mockUpdateProfilePhotoMicrosoft.mockClear();
    mockPrismaUserFindFirst.mockResolvedValueOnce(null);
    await service.completeSignIn({ userId: 7, user, account });
    expect(mockUpdateProfilePhotoMicrosoft).not.toHaveBeenCalled();
  });
});
