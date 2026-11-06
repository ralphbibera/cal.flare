import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPassword } from "@calcom/features/auth/lib/verifyPassword";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLocalD1, seedD1 } from "./seed-d1.mjs";

const readmeUsers = [
  { email: "free@example.com", password: "free", role: "USER", completedOnboarding: 1, schedules: 1 },
  { email: "pro@example.com", password: "pro", role: "USER", completedOnboarding: 1, schedules: 1 },
  { email: "trial@example.com", password: "trial", role: "USER", completedOnboarding: 1, schedules: 1 },
  {
    email: "admin@example.com",
    password: "ADMINadmin2022!",
    role: "ADMIN",
    completedOnboarding: 1,
    schedules: 1,
  },
  {
    email: "onboarding@example.com",
    password: "onboarding",
    role: "USER",
    completedOnboarding: 0,
    schedules: 0,
  },
];

describe("D1 development seed", () => {
  let directory: string;
  let persistTo: string;

  async function read<T>(query: (db: Awaited<ReturnType<typeof openLocalD1>>["db"]) => Promise<T>) {
    const { mf, db } = await openLocalD1(persistTo);
    try {
      return await query(db);
    } finally {
      await mf.dispose();
    }
  }

  const tableCounts = () =>
    read(async (db) => {
      const { results } = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
        )
        .all<{ name: string }>();
      const counts: Record<string, unknown> = {};
      for (const { name } of results) {
        counts[name] = await db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).first("count");
      }
      return counts;
    });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-seed-d1-"));
    persistTo = join(directory, "state");
    await seedD1({ persistTo });
  }, 300_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("creates the README development users with working passwords", async () => {
    const users = await read(async (db) =>
      Promise.all(
        readmeUsers.map((user) =>
          db
            .prepare(
              `SELECT u."role", u."completedOnboarding", u."emailVerified" IS NOT NULL AS "verified", p."hash",
                (SELECT COUNT(*) FROM "Schedule" s WHERE s."userId" = u."id") AS "schedules"
               FROM "users" u JOIN "UserPassword" p ON p."userId" = u."id" WHERE u."email" = ?`
            )
            .bind(user.email)
            .first<{
              role: string;
              completedOnboarding: number;
              verified: number;
              hash: string;
              schedules: number;
            }>()
        )
      )
    );
    for (const [index, { email, password, ...expected }] of readmeUsers.entries()) {
      const user = users[index];
      expect(user, email).toMatchObject({ ...expected, verified: 1 });
      await expect(verifyPassword(password, user?.hash ?? "")).resolves.toBe(true);
    }
  });

  it("seeds the pro user's event types and bookings", async () => {
    const { slugs, bookings } = await read(async (db) => ({
      slugs: (
        await db
          .prepare(
            `SELECT e."slug" FROM "EventType" e JOIN "users" u ON u."id" = e."userId" WHERE u."email" = 'pro@example.com' ORDER BY e."slug"`
          )
          .all<{ slug: string }>()
      ).results.map(({ slug }) => slug),
      bookings: await db
        .prepare(
          `SELECT COUNT(*) AS count FROM "Booking" b JOIN "users" u ON u."id" = b."userId" WHERE u."email" = 'pro@example.com'`
        )
        .first("count"),
    }));
    expect(slugs).toEqual([
      "30min",
      "60min",
      "daily",
      "google-meet",
      "in-person",
      "multiple-duration",
      "paid",
      "tennis-class",
      "yoga-class",
      "zoom",
    ]);
    expect(bookings).toBe(18);
  });

  it("adds no rows when run again", async () => {
    const before = await tableCounts();
    await seedD1({ persistTo });
    expect(await tableCounts()).toEqual(before);
  }, 300_000);
});
