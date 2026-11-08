import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prisma from "@calcom/prisma";
import type { EventType, User } from "@calcom/prisma/client";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEventTypesFromGroup } from "./getEventTypesFromGroup.handler";

let directory: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let proUser: User;
let proUserEventTypes: EventType[];
const inD1 = <T>(callback: () => T) => withD1Database({ DB: db }, callback);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "calflare-event-types-from-group-"));
  const persistTo = join(directory, "state");
  await migrateD1({ persistTo });
  const { worker } = (await import("../../../../../../apps/web/cloudflare.config")).default;
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
  await inD1(async () => {
    proUser = await prisma.user.create({
      data: {
        email: "pro@example.com",
        username: "pro",
        name: "Pro User",
      },
    });
    proUserEventTypes = await Promise.all(
      ["personal-event-1", "personal-event-2"].map((slug) =>
        prisma.eventType.create({
          data: {
            title: slug,
            slug,
            length: 30,
            userId: proUser.id,
            users: { connect: { id: proUser.id } },
          },
        })
      )
    );
  });
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("getEventTypesFromGroup", () => {
  it("should return personal event types for a user", () =>
    inD1(async () => {
      const proUserCtx = {
        user: {
          id: proUser.id,
          name: proUser.name,
          profile: {
            name: proUser.name,
            organizationId: null,
            organization: null,
            username: proUser.username,
            id: null,
            upId: `usr-${proUser.id}`,
          },
        } as NonNullable<TrpcSessionUser>,
        prisma,
      };

      const res = await getEventTypesFromGroup({
        ctx: proUserCtx,
        input: {
          group: {
            teamId: null,
            parentId: null,
          },
          limit: 10,
          cursor: null,
        },
      });

      const resEventTypeIds = res.eventTypes.map((et) => et.id);
      const proUserEventTypeIds = proUserEventTypes.map((et) => et.id);

      expect(res.eventTypes).toBeDefined();
      expect(res.eventTypes.length).toBeGreaterThan(0);
      expect(resEventTypeIds).toEqual(expect.arrayContaining(proUserEventTypeIds));
      expect(resEventTypeIds.length).toBe(proUserEventTypeIds.length);
    }));
});
