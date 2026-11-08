import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getFeatureRepository } from "./FeatureRepository";

const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const cleanupFunctions: Array<() => Promise<void>> = [];

let directory: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const inD1 = <T>(callback: () => T) => withD1Database({ DB: db }, callback);
const d1Test = (name: string, callback: () => unknown) => it(name, () => inD1(callback));

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "calflare-feature-repository-"));
  const persistTo = join(directory, "state");
  await migrateD1({ persistTo });
  const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
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
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

afterEach(() =>
  inD1(async () => {
    for (const cleanup of cleanupFunctions) {
      await cleanup();
    }
    cleanupFunctions.length = 0;
  })
);

interface TestEntities {
  testFeatureSlug: string;
}

async function setup(): Promise<TestEntities> {
  const id = uniqueId();
  const testFeatureSlug = `test-memoize-feature-${id}`;

  const cleanup = async () => {
    await prisma.feature.deleteMany({
      where: { slug: testFeatureSlug },
    });
  };

  cleanupFunctions.push(cleanup);

  return {
    testFeatureSlug,
  };
}

describe("FeatureRepository DI Container Integration Tests", () => {
  describe("getFeatureRepository with @Memoize decorator", () => {
    d1Test("should return the cached feature repository instance", () => {
      const repo1 = getFeatureRepository();
      const repo2 = getFeatureRepository();

      expect(repo1).toBeDefined();
      expect(repo2).toBeDefined();
      expect(repo1).toBe(repo2);
    });

    d1Test("should find a feature by slug using the cached repository", async () => {
      const { testFeatureSlug } = await setup();

      await prisma.feature.create({
        data: {
          slug: testFeatureSlug,
          enabled: true,
          type: "OPERATIONAL",
          description: "Test feature for memoize integration test",
        },
      });

      const repo = getFeatureRepository();
      const feature = await repo.findBySlug(testFeatureSlug);

      expect(feature).not.toBeNull();
      expect(feature?.slug).toBe(testFeatureSlug);
      expect(feature?.enabled).toBe(true);
    });

    d1Test("should return null for non-existent feature", async () => {
      const { testFeatureSlug } = await setup();

      const repo = getFeatureRepository();
      const feature = await repo.findBySlug(testFeatureSlug);

      expect(feature).toBeNull();
    });

    d1Test("should check if feature is enabled globally", async () => {
      const { testFeatureSlug } = await setup();

      await prisma.feature.create({
        data: {
          slug: testFeatureSlug,
          enabled: true,
          type: "OPERATIONAL",
          description: "Test feature for memoize integration test",
        },
      });

      const repo = getFeatureRepository();
      const isEnabled = await repo.checkIfFeatureIsEnabledGlobally(testFeatureSlug);

      expect(isEnabled).toBe(true);
    });

    d1Test("should return false for disabled feature", async () => {
      const { testFeatureSlug } = await setup();

      await prisma.feature.create({
        data: {
          slug: testFeatureSlug,
          enabled: false,
          type: "OPERATIONAL",
          description: "Test feature for memoize integration test",
        },
      });

      const repo = getFeatureRepository();
      const isEnabled = await repo.checkIfFeatureIsEnabledGlobally(testFeatureSlug);

      expect(isEnabled).toBe(false);
    });

    d1Test("should find all features", async () => {
      const { testFeatureSlug } = await setup();

      await prisma.feature.create({
        data: {
          slug: testFeatureSlug,
          enabled: true,
          type: "OPERATIONAL",
          description: "Test feature for memoize integration test",
        },
      });

      const repo = getFeatureRepository();
      const features = await repo.findAll();

      expect(Array.isArray(features)).toBe(true);
      const testFeature = features.find((f) => f.slug === testFeatureSlug);
      expect(testFeature).toBeDefined();
    });

    d1Test("should update a feature and invalidate cache via @Unmemoize", async () => {
      const { testFeatureSlug } = await setup();

      await prisma.feature.create({
        data: {
          slug: testFeatureSlug,
          enabled: false,
          type: "OPERATIONAL",
          description: "Test feature for memoize integration test",
        },
      });

      const repo = getFeatureRepository();

      const beforeUpdate = await repo.findBySlug(testFeatureSlug);
      expect(beforeUpdate?.enabled).toBe(false);

      await repo.update({
        featureId: testFeatureSlug as Parameters<typeof repo.update>[0]["featureId"],
        enabled: true,
      });

      const afterUpdate = await repo.findBySlug(testFeatureSlug);
      expect(afterUpdate?.enabled).toBe(true);
    });
  });
});
