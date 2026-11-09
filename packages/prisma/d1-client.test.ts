import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "./client";
import { withD1Database } from "./d1";
import { BookingStatus } from "./enums";
import defaultPrisma, { customPrisma, prisma, readonlyPrisma } from "./index";
import { migrateD1 } from "./migrate-d1.mts";

describe("request-bound Prisma D1 client", () => {
  let root: string;
  const runtimes: Miniflare[] = [];
  const databases: Awaited<ReturnType<Miniflare["getD1Database"]>>[] = [];
  const request = <T>(callback: () => T, index = 0) => withD1Database({ DB: databases[index] }, callback);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "prisma-d1-client-"));
    const first = join(root, "first");
    const second = join(root, "second");
    expect(await migrateD1({ persistTo: first })).toMatchObject({ applied: 6, total: 6 });
    await cp(first, second, { recursive: true });
    const { worker } = (await import("../../apps/web/cloudflare.config")).default;
    for (const [index, state] of [first, second].entries()) {
      const runtime = new Miniflare({
        cf: false,
        enableDevRegistry: false,
        telemetry: { enabled: false },
        resourcePersistencePath: join(state, "v3"),
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
      runtimes.push(runtime);
      const db = await runtime.getD1Database("DB");
      databases.push(db);
      await db
        .prepare("INSERT INTO users (id, uuid, email, username) VALUES (1, ?, ?, ?)")
        .bind(`owner-${index}`, `owner-${index}@example.com`, `owner-${index}`)
        .run();
    }
  }, 120_000);

  afterAll(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("imports without bindings and rejects queries or connection overrides outside its contract", () => {
    expect(() => prisma.user.findMany()).toThrow("D1 request binding is required");
    expect(() => customPrisma({ datasourceUrl: "file:other.db" })).toThrow("request D1 binding");
    expect(() => customPrisma({ datasources: { db: { url: "file:other.db" } } })).toThrow(
      "request D1 binding"
    );
  });

  it("isolates overlapping request bindings across awaits for named, default, custom and read-only clients", async () => {
    const custom = customPrisma({ errorFormat: "minimal", omit: { user: { bio: true } } });
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const first = request(async () => {
      const user = await defaultPrisma.user.findUniqueOrThrow({ where: { id: 1 } });
      firstStarted.resolve();
      await secondStarted.promise;
      return [user.email, (await readonlyPrisma.user.findUniqueOrThrow({ where: { id: 1 } })).email];
    });
    const second = request(async () => {
      await firstStarted.promise;
      const user = await custom.user.findUniqueOrThrow({ where: { id: 1 } });
      secondStarted.resolve();
      expect(user).not.toHaveProperty("bio");
      return [user.email, (await prisma.user.findUniqueOrThrow({ where: { id: 1 } })).email];
    }, 1);
    expect(await Promise.all([first, second])).toEqual([
      ["owner-0@example.com", "owner-0@example.com"],
      ["owner-1@example.com", "owner-1@example.com"],
    ]);
  });

  it("retains locked-user, pending-payment and undefined-filter guards", async () =>
    request(async () => {
      await prisma.user.create({ data: { email: "locked@example.com", locked: true } });
      await prisma.team.create({ data: { name: "Pending", pendingPayment: true } });
      expect(await prisma.user.findFirst({ where: { email: "locked@example.com" } })).toBeNull();
      expect(
        await prisma.user.findFirst({ where: { email: "locked@example.com", locked: true } })
      ).not.toBeNull();
      expect(await prisma.team.findFirst({ where: { name: "Pending" } })).toBeNull();
      expect(
        await prisma.team.findFirst({ where: { name: "Pending", pendingPayment: true } })
      ).not.toBeNull();
      await expect(prisma.user.deleteMany({ where: { id: undefined } })).rejects.toThrow(
        'field "id" cannot be undefined'
      );
      await expect(
        prisma.user.updateMany({ where: { id: { in: undefined } }, data: { name: "changed" } })
      ).rejects.toThrow('"in" value for the field "id" cannot be undefined');
      expect(await prisma.user.findUnique({ where: { id: 1 }, select: { name: true } })).toEqual({
        name: null,
      });
    }));

  it("keeps Date precision, ordinary JSON null sentinels, generated defaults and Prisma failures", async () =>
    request(async () => {
      const date = new Date("2026-11-05T12:34:56.789Z");
      const user = await prisma.user.create({
        data: {
          email: "roundtrip@example.com",
          createdDate: date,
          metadata: Prisma.JsonNull,
        },
      });
      expect(user.createdDate).toEqual(date);
      expect(user.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(user.metadata).toBeNull();
      expect(
        await databases[0].prepare("SELECT created, metadata FROM users WHERE id = ?").bind(user.id).first()
      ).toEqual({ created: "2026-11-05T12:34:56.789+00:00", metadata: "null" });
      await prisma.user.update({ where: { id: user.id }, data: { metadata: Prisma.DbNull } });
      expect(
        await databases[0].prepare("SELECT metadata FROM users WHERE id = ?").bind(user.id).first()
      ).toEqual({ metadata: null });
      await expect(prisma.user.create({ data: { email: user.email } })).rejects.toMatchObject({
        code: "P2002",
      });
      await expect(
        prisma.user.update({ where: { id: -1 }, data: { name: "missing" } })
      ).rejects.toMatchObject({ code: "P2025" });
    }));

  it("retains booking idempotency creation and cancellation extension effects", async () =>
    request(async () => {
      const data = {
        title: "Extension",
        startTime: new Date("2026-11-05T12:00:00.123Z"),
        endTime: new Date("2026-11-05T12:30:00.123Z"),
        status: BookingStatus.ACCEPTED,
        user: { connect: { id: 1 } },
      };
      const booking = await prisma.booking.create({ data: { ...data, uid: "extension" } });
      expect(booking.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      await expect(prisma.booking.create({ data: { ...data, uid: "duplicate" } })).rejects.toMatchObject({
        code: "P2002",
      });
      expect(
        await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CANCELLED } })
      ).toMatchObject({ idempotencyKey: null });
    }));
});
