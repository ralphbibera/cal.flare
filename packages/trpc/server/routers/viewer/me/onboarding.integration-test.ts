import { checkOnboardingRedirect } from "@calcom/features/auth/lib/onboardingUtils";
import { DEFAULT_SCHEDULE } from "@calcom/lib/availability";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { createHandler as createSchedule } from "@calcom/trpc/server/routers/viewer/availability/schedule/create.handler";
import { describe, expect } from "vitest";
import { updateProfileHandler } from "./updateProfile.handler";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
});

const userId = 1;
const email = "classic@calflare.test";

const sessionUser = {
  id: userId,
  email,
  emailVerified: new Date("2026-01-01T00:00:00.000+00:00"),
  username: "classic",
  locale: "en",
  metadata: {},
  timeZone: "Europe/London",
  organizationId: null,
  movedToProfileId: null,
  defaultScheduleId: null,
} as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"];

const updateProfile = (input: Parameters<typeof updateProfileHandler>[0]["input"]) =>
  updateProfileHandler({ ctx: { user: sessionUser }, input });

const user = () =>
  d1.db
    .prepare(
      'SELECT "name", "timeZone", "bio", "completedOnboarding", "defaultScheduleId" FROM users WHERE id = ?'
    )
    .bind(userId)
    .first<{
      name: string;
      timeZone: string;
      bio: string;
      completedOnboarding: number;
      defaultScheduleId: number | null;
    }>();

d1.beforeEach(async () => {
  await d1.db.batch([
    d1.db.prepare('DELETE FROM "Availability"'),
    d1.db.prepare('DELETE FROM "Schedule"'),
    d1.db.prepare('DELETE FROM "Membership"'),
    d1.db.prepare('DELETE FROM "Team"'),
    d1.db.prepare('DELETE FROM "Feature"'),
    d1.db.prepare("DELETE FROM users"),
    d1.db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, name, created, completedOnboarding, emailVerified, identityProvider)
         VALUES (?, 'classic-user', ?, 'classic', NULL, '2026-01-01T00:00:00.000Z', 0, '2026-01-01T00:00:00.000Z', 'CAL')`
      )
      .bind(userId, email),
  ]);
});

describe("classic onboarding steps on D1", () => {
  d1.it("persists the user-settings step fields", async () => {
    await updateProfile({ name: "Classic Person", timeZone: "America/New_York" });

    expect(await user()).toMatchObject({
      name: "Classic Person",
      timeZone: "America/New_York",
      completedOnboarding: 0,
    });
  });

  d1.it("creates the default schedule and availability for the availability step", async () => {
    await updateProfile({ name: "Classic Person", timeZone: "America/New_York" });

    const result = await createSchedule({
      ctx: { user: { id: userId, timeZone: "America/New_York", defaultScheduleId: null } },
      input: { name: "Default schedule", schedule: DEFAULT_SCHEDULE },
    });

    expect(result.schedule).toMatchObject({ name: "Default schedule", userId, timeZone: "America/New_York" });
    const schedule = await d1.db
      .prepare('SELECT id, "timeZone" FROM "Schedule" WHERE userId = ?')
      .bind(userId)
      .first<{ id: number; timeZone: string }>();
    expect(schedule).toEqual({ id: result.schedule.id, timeZone: "America/New_York" });
    expect(
      (await d1.db.prepare('SELECT id FROM "Availability" WHERE scheduleId = ?').bind(schedule!.id).all())
        .results
    ).toHaveLength(1);
    expect(await user()).toMatchObject({ defaultScheduleId: schedule!.id });
  });

  d1.it("completes the profile step, persists completion and stops redirecting to onboarding", async () => {
    expect(await checkOnboardingRedirect(userId)).toBe("/getting-started");

    await updateProfile({ name: "Classic Person", timeZone: "America/New_York" });
    const result = await updateProfile({ bio: "Synthetic bio", completedOnboarding: true });

    expect(result).toMatchObject({ completedOnboarding: true });
    expect(await user()).toMatchObject({
      name: "Classic Person",
      bio: "Synthetic bio",
      completedOnboarding: 1,
    });
    expect(await checkOnboardingRedirect(userId)).toBeNull();
  });
});
