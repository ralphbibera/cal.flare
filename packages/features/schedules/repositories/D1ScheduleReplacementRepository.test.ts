import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@calcom/lib/errorCodes";
import type { User } from "@calcom/prisma/client";
import { Prisma } from "@calcom/prisma/client";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import cloudflareConfig from "../../../../apps/web/cloudflare.config";
import { ScheduleService } from "../services/ScheduleService";
import { D1ScheduleReplacementRepository } from "./D1ScheduleReplacementRepository";
import { ScheduleRepository } from "./ScheduleRepository";

const { worker } = cloudflareConfig;

vi.mock("@calcom/lib/hasEditPermissionForUser", () => ({
  hasEditPermissionForUserID: vi.fn(),
  hasReadPermissionsForUserId: vi.fn(),
}));

let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const startTime = new Date("2026-11-05T12:34:56.789Z");
const endTime = new Date("2026-11-05T14:34:56.789Z");
const range = { startTime, endTime };
const input = { scheduleId: 1, name: "Replacement", availability: [{ ...range, days: [2, 1] }] };
const replace = (value = input) =>
  withD1Database({ DB: db }, () => D1ScheduleReplacementRepository.replace(value));
const rows = async () => (await db.prepare('SELECT * FROM "Availability" ORDER BY "id"').all()).results;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-schedule-"));
  const persistTo = join(root, "state");
  expect(await migrateD1({ persistTo })).toMatchObject({ applied: 4, total: 4 });
  mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(persistTo, "v3"),
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: { DB: worker.env.DB },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await db.batch([
    db.prepare('DELETE FROM "EventType"'),
    db.prepare('DELETE FROM "Availability"'),
    db.prepare('DELETE FROM "Schedule"'),
    db.prepare('DELETE FROM "users"'),
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'Availability'"),
    db.prepare(
      'INSERT INTO "users" ("id", "uuid", "email") VALUES (1, \'synthetic\', \'schedule@calflare.test\')'
    ),
    db.prepare(
      'INSERT INTO "Schedule" ("id", "userId", "name", "timeZone") VALUES (1, 1, \'Original\', \'Europe/London\'), (2, 1, \'Other\', NULL)'
    ),
    db
      .prepare(
        'INSERT INTO "Availability" ("id", "scheduleId", "days", "startTime", "endTime") VALUES (10, 1, \'[5]\', ?, ?), (20, 2, NULL, ?, ?)'
      )
      .bind(...Array(2).fill(["2026-11-05T09:00:00.000+00:00", "2026-11-05T10:00:00.000+00:00"]).flat()),
  ]);
});

describe("schedule replacement on D1", () => {
  it("preserves selected relations, insertion order, IDs, nullable defaults and exact date text", async () => {
    await db
      .prepare(
        "INSERT INTO \"EventType\" (\"id\", \"title\", \"slug\", \"length\", \"eventName\", \"scheduleId\", \"instantMeetingScheduleId\") VALUES (3, 'Third', 'third', 30, NULL, 1, NULL), (2, 'Second', 'second', 30, 'Named', 1, NULL), (1, 'Other', 'other', 30, 'Excluded', 2, 1)"
      )
      .run();
    const result = await withD1Database({ DB: db }, () =>
      D1ScheduleReplacementRepository.replace({
        ...input,
        timeZone: "Asia/Manila",
        availability: [
          input.availability[0],
          { ...range, days: [], date: startTime },
          { ...range, date: startTime },
        ],
      })
    );
    const common = { userId: null, eventTypeId: null, scheduleId: 1, startTime, endTime };
    expect(result).toEqual({
      id: 1,
      userId: 1,
      name: "Replacement",
      timeZone: "Asia/Manila",
      availability: [
        { ...common, id: 21, days: [2, 1], date: null },
        { ...common, id: 22, days: [], date: startTime },
        { ...common, id: 23, days: [], date: startTime },
      ],
      eventType: [
        { id: 2, eventName: "Named" },
        { id: 3, eventName: null },
      ],
    });
    const stored = await rows();
    expect(stored).toHaveLength(4);
    expect(stored.slice(1)).toEqual(
      result.availability.map((row, index) => ({
        ...row,
        days: index === 2 ? null : JSON.stringify(row.days),
        startTime: "2026-11-05T12:34:56.789+00:00",
        endTime: "2026-11-05T14:34:56.789+00:00",
        date: index === 0 ? null : "2026-11-05T12:34:56.789+00:00",
      }))
    );
    expect(stored[0]).toMatchObject({ id: 20, scheduleId: 2, days: null });
  });

  it("allows empty replacement and retains an omitted time zone", async () => {
    expect(await replace({ ...input, availability: [] })).toEqual({
      id: 1,
      userId: 1,
      name: input.name,
      timeZone: "Europe/London",
      availability: [],
      eventType: [],
    });
    expect(await rows()).toHaveLength(1);
  });

  it.each([
    { availability: [] },
    { availability: input.availability },
  ])("rejects a missing Schedule without zero-row success (%j)", async ({ availability }) => {
    const before = await rows();
    await expect(replace({ ...input, scheduleId: 999, availability })).rejects.toMatchObject({
      code: "P2025",
      meta: { modelName: "Schedule" },
    });
    await expect(replace({ ...input, scheduleId: 999, availability })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError
    );
    expect(await rows()).toEqual(before);
    expect(await db.prepare('SELECT "id" FROM "Schedule" WHERE "id" = 999').first()).toBeNull();
  });

  it("rolls back deletes, name, time zone and earlier inserts after a later insert fails", async () => {
    const before = await rows();
    await db
      .prepare(`CREATE TRIGGER fail_later_availability BEFORE INSERT ON "Availability"
      WHEN NEW."days" = '[6]' BEGIN SELECT RAISE(ABORT, 'synthetic later constraint failed'); END`)
      .run();
    try {
      await expect(
        withD1Database({ DB: db }, () =>
          D1ScheduleReplacementRepository.replace({
            ...input,
            timeZone: "Asia/Manila",
            availability: [...input.availability, { ...range, days: [6] }],
          })
        )
      ).rejects.toMatchObject({ code: ErrorCode.BadRequest });
      expect(await rows()).toEqual(before);
      expect(await db.prepare('SELECT "name", "timeZone" FROM "Schedule" WHERE "id" = 1').first()).toEqual({
        name: "Original",
        timeZone: "Europe/London",
      });
    } finally {
      await db.prepare("DROP TRIGGER fail_later_availability").run();
    }
  });

  it("serializes concurrent replacements with their own selected rows and no mixed availability", async () => {
    const [first, second] = await Promise.all([
      replace(input),
      replace({ ...input, name: "Concurrent", availability: [{ ...range, days: [4] }] }),
    ]);
    expect(first.availability.map((row) => row.days)).toEqual([[2, 1]]);
    expect(second.availability.map((row) => row.days)).toEqual([[4]]);
    const final = await db.prepare('SELECT "name" FROM "Schedule" WHERE "id" = 1').first<{ name: string }>();
    const winner = final?.name === first.name ? first : second;
    const stored = await db.prepare('SELECT "id", "days" FROM "Availability" WHERE "scheduleId" = 1').all();
    expect(stored.results).toEqual(
      winner.availability.map(({ id, days }) => ({ id, days: JSON.stringify(days) }))
    );
  });

  it("integrates service transforms, duplicate overrides and the separate default update", async () => {
    const user = { id: 1, defaultScheduleId: 2, timeZone: "Europe/London" };
    prismaMock.schedule.findUnique.mockResolvedValue({
      id: 1,
      userId: 1,
      name: "Original",
      timeZone: "Europe/London",
    });
    vi.spyOn(ScheduleRepository.prototype, "setupDefaultSchedule").mockImplementation(async () => {
      await db.prepare('UPDATE "users" SET "defaultScheduleId" = 1 WHERE "id" = 1').run();
      return mock<User>({ defaultScheduleId: 1 });
    });
    const service = new ScheduleService(prismaMock);
    const result = await withD1Database({ DB: db }, () =>
      service.update({
        user,
        input: {
          scheduleId: 1,
          name: "Overrides",
          isDefault: true,
          dateOverrides: [{ start: startTime, end: endTime }],
        },
      })
    );
    expect(result).toMatchObject({
      isDefault: true,
      prevDefaultId: 2,
      currentDefaultId: 1,
      timeZone: "Europe/London",
    });
    expect(result.schedule).toMatchObject({
      name: "Overrides",
      availability: [
        { days: [], startTime, endTime, date: startTime },
        { days: [], startTime, endTime, date: startTime },
      ],
    });
    expect(
      (await db.prepare('SELECT "days" FROM "Availability" WHERE "scheduleId" = 1 ORDER BY "id"').all())
        .results
    ).toEqual([{ days: "[]" }, { days: "[]" }]);
    const weekly = await withD1Database({ DB: db }, () =>
      service.update({
        user,
        input: {
          scheduleId: 1,
          name: "Weekly",
          schedule: [[], [{ start: startTime, end: endTime }], [{ start: startTime, end: endTime }]],
          dateOverrides: [{ start: startTime, end: endTime }],
        },
      })
    );
    expect(weekly.schedule).toMatchObject({
      availability: [
        { days: [1, 2], startTime, endTime, date: null },
        { days: [], startTime, endTime, date: startTime },
      ],
    });
    const before = await rows();
    expect(await service.update({ user, input: { scheduleId: 1, isDefault: true } })).toEqual({
      schedule: { id: 1, userId: 1, name: "Original", timeZone: "Europe/London" },
      isDefault: true,
    });
    expect(await rows()).toEqual(before);
    await db.prepare('UPDATE "users" SET "defaultScheduleId" = 2 WHERE "id" = 1').run();
    await db
      .prepare(`CREATE TRIGGER fail_schedule_update BEFORE UPDATE ON "Schedule"
      BEGIN SELECT RAISE(ABORT, 'synthetic constraint failed'); END`)
      .run();
    try {
      await expect(
        withD1Database({ DB: db }, () =>
          service.update({
            user,
            input: { scheduleId: 1, name: "Fails", isDefault: true },
          })
        )
      ).rejects.toMatchObject({ code: ErrorCode.BadRequest });
      expect(await rows()).toEqual(before);
      expect(await db.prepare('SELECT "defaultScheduleId" FROM "users" WHERE "id" = 1').first()).toEqual({
        defaultScheduleId: 1,
      });
    } finally {
      await db.prepare("DROP TRIGGER fail_schedule_update").run();
    }
  });
});
