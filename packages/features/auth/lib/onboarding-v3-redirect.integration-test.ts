import { checkOnboardingRedirect } from "@calcom/features/auth/lib/onboardingUtils";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect } from "vitest";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../apps/web/cloudflare.config")).default.worker,
});

const seedUser = (values: {
  id: number;
  email: string;
  created?: string;
  completedOnboarding?: number;
  emailVerified?: string | null;
  identityProvider?: string;
}) =>
  d1.db
    .prepare(
      `INSERT INTO users (id, uuid, email, username, created, completedOnboarding, emailVerified, identityProvider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      values.id,
      `onboarding-${values.id}`,
      values.email,
      `onboarding-${values.id}`,
      values.created ?? "2026-01-01T00:00:00.000Z",
      values.completedOnboarding ?? 0,
      values.emailVerified === undefined ? "2026-01-01T00:00:00.000Z" : values.emailVerified,
      values.identityProvider ?? "CAL"
    )
    .run();

d1.beforeAll(async () => {
  await d1.db.batch([
    d1.db.prepare(
      `INSERT INTO "Feature" (slug, enabled) VALUES ('onboarding-v3', 1), ('email-verification', 1)
       ON CONFLICT(slug) DO UPDATE SET enabled = 1`
    ),
  ]);
});

d1.beforeEach(async () => {
  await d1.db.batch([
    d1.db.prepare('DELETE FROM "Profile"'),
    d1.db.prepare('DELETE FROM "Membership"'),
    d1.db.prepare("DELETE FROM users"),
    d1.db.prepare('DELETE FROM "Team"'),
  ]);
});

describe("v3 onboarding redirect on D1", () => {
  d1.it("sends an incomplete personal user to the v3 getting-started page", async () => {
    await seedUser({ id: 11, email: "personal@calflare.test" });

    await expect(checkOnboardingRedirect(11)).resolves.toBe("/onboarding/getting-started");
  });

  d1.it("sends an invited user with a team membership to the v3 personal settings step", async () => {
    await seedUser({ id: 12, email: "invited@calflare.test" });
    await d1.db.batch([
      d1.db.prepare(
        `INSERT INTO "Team" (id, name, slug, isOrganization) VALUES (12, 'Inviting team', 'inviting', 0)`
      ),
      d1.db.prepare(
        "INSERT INTO \"Membership\" (teamId, userId, role, accepted) VALUES (12, 12, 'MEMBER', 1)"
      ),
    ]);

    await expect(checkOnboardingRedirect(12)).resolves.toBe("/onboarding/personal/settings");
  });

  d1.it("stops redirecting a completed user", async () => {
    await seedUser({ id: 13, email: "complete@calflare.test", completedOnboarding: 1 });

    await expect(checkOnboardingRedirect(13)).resolves.toBeNull();
  });

  d1.it("stops redirecting a user that belongs to an organization", async () => {
    await seedUser({ id: 14, email: "member@example.com" });
    await d1.db.batch([
      d1.db.prepare(`INSERT INTO "Team" (id, name, slug, isOrganization) VALUES (14, 'Org', 'org', 1)`),
      d1.db.prepare(
        `INSERT INTO "Profile" (uid, userId, organizationId, username, updatedAt)
         VALUES ('org-profile', 14, 14, 'member', '2026-01-01T00:00:00.000Z')`
      ),
    ]);

    await expect(checkOnboardingRedirect(14)).resolves.toBeNull();
  });

  d1.it("stops redirecting a user created before onboarding was introduced", async () => {
    await seedUser({ id: 15, email: "legacy@calflare.test", created: "2021-01-01T00:00:00.000Z" });

    await expect(checkOnboardingRedirect(15)).resolves.toBeNull();
  });

  d1.it("checks email verification only for an unverified CAL identity", async () => {
    await seedUser({ id: 16, email: "unverified@calflare.test", emailVerified: null });
    await seedUser({ id: 17, email: "verified@calflare.test" });
    await seedUser({
      id: 18,
      email: "google@calflare.test",
      emailVerified: null,
      identityProvider: "GOOGLE",
    });

    await expect(checkOnboardingRedirect(16, { checkEmailVerification: true })).resolves.toBe(
      "/auth/verify-email"
    );
    await expect(checkOnboardingRedirect(17, { checkEmailVerification: true })).resolves.toBe(
      "/onboarding/getting-started"
    );
    await expect(checkOnboardingRedirect(18, { checkEmailVerification: true })).resolves.toBe(
      "/onboarding/getting-started"
    );
  });
});
