import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  d1TemplateEnv,
  migrateD1,
  migrationsFingerprint,
  readMigrations,
  templateManifestPath,
} from "../migrate-d1.mjs";

declare global {
  var calflareD1Template: { root?: Promise<string>; holders: number } | undefined;
}

// Vitest runs this setup once per test project, and each project loads its own module graph, so the
// shared state has to live on globalThis. Every project holds the template until its own teardown.
const shared = globalThis.calflareD1Template ?? { holders: 0 };
globalThis.calflareD1Template = shared;

export async function setup(): Promise<void> {
  shared.holders += 1;
  shared.root ??= buildTemplate().catch((error: unknown) => {
    // A cached rejection would fail every later setup in this process without retrying.
    shared.root = undefined;
    throw error;
  });
  await shared.root;
}

async function buildTemplate(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "calflare-d1-template-"));
  try {
    const template = join(directory, "state");
    const migrations = await readMigrations();
    await migrateD1({ persistTo: template, useTemplate: false });
    await writeFile(templateManifestPath(template), migrationsFingerprint(migrations));
    // Fork workers copy process.env when they spawn, and that happens after every global setup ran.
    process.env[d1TemplateEnv] = template;
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function teardown(): Promise<void> {
  shared.holders -= 1;
  if (shared.holders > 0 || !shared.root) return;
  const directory = await shared.root.catch(() => undefined);
  shared.root = undefined;
  if (!directory) return;
  delete process.env[d1TemplateEnv];
  await rm(directory, { recursive: true, force: true });
}
