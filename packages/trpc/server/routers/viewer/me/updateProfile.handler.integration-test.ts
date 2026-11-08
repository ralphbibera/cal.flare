import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect } from "vitest";
import { updateProfileHandler } from "./updateProfile.handler";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
});

const verified = "2026-01-01T00:00:00.000+00:00";
const user = {
  id: 1,
  email: "jane@example.com",
  emailVerified: new Date(verified),
  username: "jane",
  locale: "en",
  metadata: {},
  timeZone: "Europe/London",
  organizationId: null,
  movedToProfileId: null,
  defaultScheduleId: null,
} as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"];
const update = (secondaryEmails: { id: number; email: string; isDeleted: boolean }[]) =>
  updateProfileHandler({ ctx: { user }, input: { secondaryEmails } });

describe("updateProfile secondary email updates on D1", () => {
  const secondaryEmails = async () =>
    (
      await d1.db
        .prepare(
          'SELECT "id", "email", "emailVerified" FROM "SecondaryEmail" WHERE "userId" = 1 ORDER BY "id"'
        )
        .all()
    ).results;

  d1.beforeAll(async () => {
    await d1.db
      .prepare(`INSERT INTO users ("id", "uuid", "email", "username")
        VALUES (1, 'user-1', 'jane@example.com', 'jane'), (2, 'user-2', 'john@example.com', 'john')`)
      .run();
  }, 60_000);

  d1.beforeEach(async () => {
    await d1.db.batch([
      d1.db.prepare('DELETE FROM "SecondaryEmail"'),
      d1.db
        .prepare(`INSERT INTO "SecondaryEmail" ("id", "userId", "email", "emailVerified")
          VALUES (5, 1, 'first@example.com', ?), (6, 1, 'second@example.com', ?), (7, 2, 'taken@example.com', NULL)`)
        .bind(verified, verified),
    ]);
  });

  d1.it("renames secondary emails and clears verification only for a changed address", async () => {
    await expect(
      update([
        { id: 5, email: "renamed@example.com", isDeleted: false },
        { id: 6, email: "second@example.com", isDeleted: false },
      ])
    ).resolves.toMatchObject({ hasEmailBeenChanged: undefined, sendEmailVerification: true });

    expect(await secondaryEmails()).toEqual([
      { id: 5, email: "renamed@example.com", emailVerified: null },
      { id: 6, email: "second@example.com", emailVerified: verified },
    ]);
  });

  d1.it("keeps every secondary email when a later rename hits a unique email", async () => {
    await expect(
      update([
        { id: 5, email: "renamed@example.com", isDeleted: false },
        { id: 6, email: "taken@example.com", isDeleted: false },
      ])
    ).rejects.toMatchObject({ code: "P2002", meta: { modelName: "SecondaryEmail" } });

    expect(await secondaryEmails()).toEqual([
      { id: 5, email: "first@example.com", emailVerified: verified },
      { id: 6, email: "second@example.com", emailVerified: verified },
    ]);
  });

  d1.it("lets simultaneous identical renames both succeed", async () => {
    const renames = [{ id: 5, email: "renamed@example.com", isDeleted: false }];

    await Promise.all([update(renames), update(renames)]);

    expect(await secondaryEmails()).toEqual([
      { id: 5, email: "renamed@example.com", emailVerified: null },
      { id: 6, email: "second@example.com", emailVerified: verified },
    ]);
  });

  d1.it("persists onboarding completion for a personal account", async () => {
    const result = await updateProfileHandler({ ctx: { user }, input: { completedOnboarding: true } });

    expect(result).toMatchObject({ completedOnboarding: true });
    expect(await d1.db.prepare("SELECT completedOnboarding FROM users WHERE id = 1").first()).toEqual({
      completedOnboarding: 1,
    });
  });
});
