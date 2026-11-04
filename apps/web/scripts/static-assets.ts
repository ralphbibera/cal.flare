import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import type { SplitStaticAsset } from "../worker/static-assets";

const publicFile = "app-store/salesroom/salesroom-demo.mp4";
const partSize = 20 * 1024 * 1024;
const virtualId = "virtual:calflare-static-assets";

export function staticAssets(): Plugin {
  let config: ResolvedConfig;
  let plan: Promise<Record<string, SplitStaticAsset>> | undefined;

  const readPlan = (): Promise<Record<string, SplitStaticAsset>> => {
    if (config.command !== "build") return Promise.resolve({});
    plan ??= (async () => {
      const filename = path.join(config.publicDir, publicFile);
      const info = await stat(filename);
      if (info.size <= 25 * 1024 * 1024) return {};
      const hash = createHash("sha256")
        .update(await readFile(filename))
        .digest("hex");
      return {
        ["/" + publicFile]: {
          size: info.size,
          contentType: "video/mp4",
          etag: 'W/"' + info.size.toString(16) + "-" + info.mtime.getTime().toString(16) + '"',
          lastModified: info.mtime.toUTCString(),
          parts: Array.from({ length: Math.ceil(info.size / partSize) }, (_, index) => ({
            path: "/_next/static/calflare-assets/" + hash + "/" + index + ".bin",
            size: Math.min(partSize, info.size - index * partSize),
          })),
        },
      };
    })();
    return plan;
  };

  return {
    name: "calflare:static-assets",
    configResolved(resolved) {
      config = resolved;
    },
    resolveId(id) {
      if (id === virtualId) return "\0" + virtualId;
    },
    async load(id) {
      if (id === "\0" + virtualId) return "export default " + JSON.stringify(await readPlan());
    },
    async writeBundle() {
      if (this.environment.name !== "client") return;
      const assets = await readPlan();
      const asset = assets["/" + publicFile];
      if (!asset) return;
      const output = path.resolve(config.root, this.environment.config.build.outDir);
      const uploadCopy = path.join(output, publicFile);
      if (uploadCopy === path.join(config.publicDir, publicFile)) {
        throw new Error("Static asset output must be separate from original public files");
      }
      const bytes = await readFile(uploadCopy);
      const source = await readFile(path.join(config.publicDir, publicFile));
      if (!bytes.equals(source)) throw new Error("Generated static asset differs from its original source");
      for (const [index, part] of asset.parts.entries()) {
        const destination = path.join(output, part.path.slice(1));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes.subarray(index * partSize, index * partSize + part.size));
      }
      const retained = path.join(config.root, ".vinext/static-assets", asset.parts[0].path.split("/")[4]);
      await mkdir(retained, { recursive: true });
      await rename(uploadCopy, path.join(retained, path.basename(publicFile)));
    },
  };
}
