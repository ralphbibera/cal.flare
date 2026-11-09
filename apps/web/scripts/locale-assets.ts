import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";
import localeConfig from "../../../i18n.json";

const localesDir = fileURLToPath(new URL("../../../packages/i18n/locales", import.meta.url));

/** Publishes the runtime dictionaries next to the Worker's other static assets. */
export function localeAssets(): Plugin {
  let config: ResolvedConfig;
  let plan: Promise<{ path: string; bytes: Buffer }[]> | undefined;

  const readPlan = () => {
    if (config.command !== "build") return Promise.resolve([]);
    plan ??= Promise.all(
      localeConfig.locale.targets.map(async (locale) => ({
        path: `/_next/static/locales/${locale}/common.json`,
        bytes: await readFile(path.join(localesDir, locale, "common.json")),
      }))
    );
    return plan;
  };

  return {
    name: "calflare:locale-assets",
    configResolved(resolved) {
      config = resolved;
    },
    async writeBundle() {
      if (this.environment.name !== "client") return;
      const output = path.resolve(config.root, this.environment.config.build.outDir);
      for (const asset of await readPlan()) {
        const destination = path.join(output, asset.path.slice(1));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, asset.bytes);
        const written = await readFile(destination);
        if (!written.equals(asset.bytes)) {
          throw new Error(`Locale asset ${asset.path} differs from its source`);
        }
        JSON.parse(written.toString("utf8"));
      }
    },
  };
}
