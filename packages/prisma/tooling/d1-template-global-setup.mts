import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { d1TemplateEnv, migrateD1 } from "../migrate-d1.mts";

declare global {
  // biome-ignore lint/suspicious/noVar: globalThis properties can only be declared with var
  var calflareD1Template: { root?: Promise<string>; holders: number } | undefined;
}

// Vitest loads this module once per project, each with its own module instance, so the state lives on
// globalThis: the first caller builds the template and the last teardown removes it.
const shared = (globalThis.calflareD1Template ??= { holders: 0 });

export async function setup() {
  shared.holders += 1;
  shared.root ??= mkdtemp(join(tmpdir(), "calflare-d1-template-")).then(async (directory) => {
    const template = join(directory, "state");
    await migrateD1({ persistTo: template, useTemplate: false });
    process.env[d1TemplateEnv] = template;
    return directory;
  });
  await shared.root;
}

export async function teardown() {
  shared.holders -= 1;
  if (shared.holders > 0 || !shared.root) return;
  const directory = await shared.root;
  shared.root = undefined;
  delete process.env[d1TemplateEnv];
  await rm(directory, { recursive: true, force: true });
}
