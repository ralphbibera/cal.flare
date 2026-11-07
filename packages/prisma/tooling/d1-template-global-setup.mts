import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { d1TemplateEnv, migrateD1 } from "../migrate-d1.mjs";

declare global {
  var calflareD1Template: { root?: Promise<string>; holders: number } | undefined;
}

// Vitest runs this setup once per test project, and each project loads its own module graph, so the
// shared state has to live on globalThis. Every project holds the template until its own teardown.
const shared = globalThis.calflareD1Template ?? { holders: 0 };
globalThis.calflareD1Template = shared;

export async function setup(): Promise<void> {
  shared.holders += 1;
  shared.root ??= mkdtemp(join(tmpdir(), "calflare-d1-template-")).then(async (directory) => {
    const template = join(directory, "state");
    await migrateD1({ persistTo: template, useTemplate: false });
    // Fork workers copy process.env when they spawn, and that happens after every global setup ran.
    process.env[d1TemplateEnv] = template;
    return directory;
  });
  await shared.root;
}

export async function teardown(): Promise<void> {
  shared.holders -= 1;
  if (shared.holders > 0 || !shared.root) return;
  const directory = await shared.root;
  shared.root = undefined;
  delete process.env[d1TemplateEnv];
  await rm(directory, { recursive: true, force: true });
}
