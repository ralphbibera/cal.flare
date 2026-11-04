import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";
import { z } from "zod";

const sizeSchema = z.number().int().nonnegative().safe();
const fileSchema = z.object({ fileName: z.string(), bytes: sizeSchema, gzipBytes: sizeSchema });
const reportSchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.string(),
  consumer: z.enum(["client", "server"]),
  chunks: z
    .array(
      fileSchema.extend({
        imports: z.array(z.string()),
        dynamicImports: z.array(z.string()),
        modules: z.array(z.object({ id: z.string(), renderedLength: sizeSchema })),
      })
    )
    .min(1),
  assets: z.array(fileSchema),
});
const indexSchema = z.object({
  schemaVersion: z.literal(1),
  selection: z.enum(["all", "browser", "server"]),
  environments: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).nonempty(),
});
type BundleReport = z.infer<typeof reportSchema>;

export function bundleAnalysis(): Plugin | null {
  const target = process.env.BUNDLE_ANALYZE;
  if (target && target !== "browser" && target !== "server") {
    throw new Error(`Unsupported BUNDLE_ANALYZE=${target}. Expected browser or server.`);
  }
  if (process.env.ANALYZE !== "true" && !target) return null;

  const selection = target || "all";
  const environments = new Set<string>();
  let reportDirectory = "";
  let root = "";
  return {
    name: "calflare:bundle-analysis",
    apply: "build",
    configResolved(config) {
      root = config.root;
      reportDirectory = path.resolve(root, "dist/analyze");
      mkdirSync(reportDirectory, { recursive: true });
      writeFileSync(
        path.join(reportDirectory, "index.json"),
        JSON.stringify({ schemaVersion: 1, selection, environments: [] })
      );
    },
    writeBundle(_options, bundle) {
      const { name, config } = this.environment;
      if (selection === "browser" && config.consumer !== "client") return;
      if (selection === "server" && config.consumer !== "server") return;
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Unsupported Vite environment name: ${name}`);
      const report: BundleReport = {
        schemaVersion: 1,
        environment: name,
        consumer: config.consumer,
        chunks: [],
        assets: [],
      };
      for (const output of Object.values(bundle)) {
        if (output.fileName.endsWith(".map")) continue;
        const content = output.type === "chunk" ? output.code : output.source;
        const bytes = Buffer.byteLength(content);
        const gzipBytes = gzipSync(content).byteLength;
        if (output.type === "asset") {
          report.assets.push({ fileName: output.fileName, bytes, gzipBytes });
          continue;
        }
        report.chunks.push({
          fileName: output.fileName,
          bytes,
          gzipBytes,
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          modules: Object.entries(output.modules)
            .map(([id, module]) => ({
              id: path.isAbsolute(id) ? path.relative(root, id).replaceAll("\\", "/") : id,
              renderedLength: module.renderedLength,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        });
      }
      report.chunks.sort((a, b) => a.fileName.localeCompare(b.fileName));
      report.assets.sort((a, b) => a.fileName.localeCompare(b.fileName));
      if (!report.chunks.length) throw new Error(`No JavaScript chunks in analyzed environment ${name}`);
      writeFileSync(path.join(reportDirectory, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
      environments.add(name);
      writeFileSync(
        path.join(reportDirectory, "index.json"),
        `${JSON.stringify({ schemaVersion: 1, selection, environments: [...environments].sort() }, null, 2)}\n`
      );
      const total = report.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      this.info(
        `${name} bundle analysis: ${report.chunks.length} chunks, ${total} JS bytes; ${path.relative(root, reportDirectory)}/${name}.json`
      );
    },
  };
}

function readReports(directory: string): { selection: string; reports: Map<string, BundleReport> } {
  let index: z.infer<typeof indexSchema>;
  try {
    index = indexSchema.parse(JSON.parse(readFileSync(path.join(directory, "index.json"), "utf8")));
  } catch (cause) {
    throw new Error(
      `Native Vite bundle reports missing or incompatible in ${directory}. Rebuild with ANALYZE=true.`,
      { cause }
    );
  }
  const reports = new Map<string, BundleReport>();
  for (const environment of index.environments) {
    const report = reportSchema.parse(
      JSON.parse(readFileSync(path.join(directory, `${environment}.json`), "utf8"))
    );
    if (report.environment !== environment) throw new Error(`Mismatched report environment ${environment}`);
    reports.set(environment, report);
  }
  return { selection: index.selection, reports };
}

function modules(report: BundleReport | undefined): Map<string, number> {
  const result = new Map<string, number>();
  for (const chunk of report?.chunks ?? [])
    for (const module of chunk.modules)
      result.set(module.id, (result.get(module.id) ?? 0) + module.renderedLength);
  return result;
}

function escapeCell(value: string): string {
  return value
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\r\n\0]/g, " ");
}

export function compareBundles(baseDirectory: string, currentDirectory: string): string {
  const baseline = readReports(baseDirectory);
  const candidate = readReports(currentDirectory);
  if (baseline.selection !== candidate.selection)
    throw new Error("Bundle report selections differ. Rebuild both with the same analysis flags.");
  const base = baseline.reports;
  const current = candidate.reports;
  const lines = [
    "<!-- __NEXTJS_BUNDLE_@calcom/web -->",
    "## Vite bundle analysis",
    "",
    "Emitted chunks/assets, excluding source maps. Gzip sizes compress each emitted file separately. These are build diagnostics, not per-route download sizes.",
    "",
    "| Environment | JS bytes (base → current) | JS gzip bytes (base → current) | Asset bytes (base → current) |",
    "| --- | ---: | ---: | ---: |",
  ];
  const names = [...new Set([...base.keys(), ...current.keys()])].sort();
  for (const name of names) {
    const before = base.get(name);
    const after = current.get(name);
    if (before && after && before.consumer !== after.consumer)
      throw new Error(`Environment consumer changed for ${name}`);
    const sum = (report: BundleReport | undefined, field: "bytes" | "gzipBytes") =>
      report?.chunks.reduce((total, chunk) => total + chunk[field], 0) ?? 0;
    const assets = (report: BundleReport | undefined) =>
      report?.assets.reduce((total, asset) => total + asset.bytes, 0) ?? 0;
    lines.push(
      `| ${escapeCell(name)}${!before ? " (added)" : !after ? " (removed)" : ""} | ${sum(before, "bytes")} → ${sum(after, "bytes")} | ${sum(before, "gzipBytes")} → ${sum(after, "gzipBytes")} | ${assets(before)} → ${assets(after)} |`
    );
  }
  for (const name of names) {
    const before = modules(base.get(name));
    const after = modules(current.get(name));
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .map((id) => ({ id, before: before.get(id) ?? 0, after: after.get(id) ?? 0 }))
      .filter((change) => change.before !== change.after)
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
    lines.push(
      "",
      `### ${escapeCell(name)} module attribution`,
      "",
      "Bundler `renderedLength` units, summed across chunks. Attribution is not transfer size; chunk JSON retains imports and dynamic imports."
    );
    if (!changes.length) {
      lines.push("", "No module attribution changes.");
      continue;
    }
    lines.push("", "| Module | Base | Current | Delta |", "| --- | ---: | ---: | ---: |");
    for (const change of changes.slice(0, 20))
      lines.push(
        `| ${escapeCell(change.id)} | ${change.before} | ${change.after} | ${change.after - change.before} |`
      );
    if (changes.length > 20) lines.push("", `Showing largest 20 of ${changes.length} module changes.`);
  }
  lines.push(
    "",
    "Legacy Next per-page budgets are not applied to Vite environment totals or module attribution.",
    ""
  );
  return lines.join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, baseDirectory, currentDirectory] = process.argv.slice(2);
  if (command !== "compare" || !baseDirectory || !currentDirectory)
    throw new Error("Usage: bun scripts/bundle-analysis.ts compare <base-directory> <current-directory>");
  const comment = compareBundles(baseDirectory, currentDirectory);
  writeFileSync(path.join(currentDirectory, "__bundle_analysis_comment.md"), comment);
  process.stdout.write(comment);
}
