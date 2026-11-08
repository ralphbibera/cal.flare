import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    secondaryEmail: { findUnique: vi.fn() },
    user: { update: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("@calcom/features/flags/features.repository", () => ({
  FeaturesRepository: class {
    async checkIfFeatureIsEnabledGlobally() {
      return false;
    }
  },
}));

import { updateProfileHandler } from "./updateProfile.handler";

const user = {
  id: 1,
  email: "jane@example.com",
  emailVerified: new Date("2026-01-01T00:00:00.000Z"),
  username: "jane",
  locale: "en",
  metadata: {},
  timeZone: "Europe/London",
  organizationId: null,
  movedToProfileId: null,
  defaultScheduleId: null,
} as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"];

const changeEmail = () =>
  updateProfileHandler({ ctx: { user }, input: { email: "new@example.com" } });

function uniqueConflict(meta: Record<string, unknown>) {
  const error = new Error("Unique constraint failed") as Error & { code: string; meta: unknown };
  error.code = "P2002";
  error.meta = meta;
  return error;
}

describe("updateProfileHandler email conflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.secondaryEmail.findUnique.mockResolvedValue(null);
  });

  it("maps a D1 email unique violation to 409 email_already_used", async () => {
    prismaMock.user.update.mockRejectedValue(
      uniqueConflict({
        modelName: "User",
        driverAdapterError: {
          cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["email"] } },
        },
      })
    );

    await expect(changeEmail()).rejects.toMatchObject({
      statusCode: 409,
      message: "email_already_used",
    });
  });

  it("keeps mapping a Prisma meta.target email violation to 409", async () => {
    prismaMock.user.update.mockRejectedValue(uniqueConflict({ target: ["email"] }));

    await expect(changeEmail()).rejects.toMatchObject({
      statusCode: 409,
      message: "email_already_used",
    });
  });

  it("rethrows a username-only unique violation", async () => {
    const error = uniqueConflict({ target: ["username"] });
    prismaMock.user.update.mockRejectedValue(error);

    await expect(changeEmail()).rejects.toBe(error);
  });
});
