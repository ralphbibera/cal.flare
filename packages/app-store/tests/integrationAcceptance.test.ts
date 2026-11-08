import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppMetaType } from "@calcom/types/AppMetaSchema";
import { AppMetaSchema } from "@calcom/types/AppMetaSchema";
import { describe, expect, it } from "vitest";
import { appStoreMetadata } from "../appStoreMetaData";

const APP_STORE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const INVENTORY_PATH = join(REPO_ROOT, "docs/porting/inventory/integrations.tsv");
const BASELINE_INTEGRATION_COUNT = 106;

const INVENTORY_COLUMNS = [
  "integration",
  "metadata",
  "destination",
  "enablement_variables",
  "contract",
  "domain",
] as const;
type InventoryColumn = (typeof INVENTORY_COLUMNS)[number];

type ServiceMapSpec = {
  fileName: string;
  exportName: string;
  serviceFile: string;
  category?: string;
};

const SERVICE_MAP_SPECS: ServiceMapSpec[] = [
  {
    fileName: "payment.services.generated.ts",
    exportName: "PaymentServiceMap",
    serviceFile: "lib/PaymentService.ts",
  },
  {
    fileName: "calendar.services.generated.ts",
    exportName: "CalendarServiceMap",
    serviceFile: "lib/CalendarService.ts",
    category: "calendar",
  },
  {
    fileName: "crm.apps.generated.ts",
    exportName: "CrmServiceMap",
    serviceFile: "lib/CrmService.ts",
    category: "crm",
  },
  {
    fileName: "video.adapters.generated.ts",
    exportName: "VideoApiAdapterMap",
    serviceFile: "lib/VideoApiAdapter.ts",
  },
  {
    fileName: "analytics.services.generated.ts",
    exportName: "AnalyticsServiceMap",
    serviceFile: "lib/AnalyticsService.ts",
  },
];

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const parseInventory = (source: string) => {
  const [headerLine, ...lines] = source.trimEnd().split(/\r?\n/);
  const header = headerLine.split("\t");
  const rows = lines.map((line) => {
    const cells = line.split("\t");
    if (cells.length !== INVENTORY_COLUMNS.length) {
      throw new Error(
        `Inventory row has ${cells.length} columns instead of ${INVENTORY_COLUMNS.length}: ${line}`
      );
    }
    const row = Object.fromEntries(
      INVENTORY_COLUMNS.map((column, index) => [column, cells[index]])
    ) as Record<InventoryColumn, string>;
    return {
      ...row,
      enablementVariables: row.enablement_variables ? row.enablement_variables.split(",") : [],
    };
  });
  return { header, rows };
};

const parseGeneratedMap = (fileName: string, exportName: string) => {
  const source = readFileSync(join(APP_STORE_DIR, fileName), "utf8");
  const imports = new Map<string, string>();
  for (const match of Array.from(source.matchAll(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+"([^"]+)";$/gm))) {
    if (match[1]) {
      for (const part of match[1].split(",")) {
        const imported = part.trim().match(/^(?:(\w+)\s+as\s+)?(\w+)$/);
        if (imported) imports.set(imported[2], match[3]);
      }
      continue;
    }
    imports.set(match[2], match[3]);
  }

  const exportAt = source.indexOf(`export const ${exportName}`);
  if (exportAt === -1) {
    throw new Error(`${fileName} does not export ${exportName}`);
  }

  const entries = new Map<string, string>();
  for (const match of Array.from(source.slice(exportAt).matchAll(/^\s+"?([\w-]+)"?:\s*(.+?),\s*$/gm))) {
    const value = match[2].trim();
    const lazyImport = value.match(/^import\("([^"]+)"\)$/);
    const resolved = lazyImport ? lazyImport[1] : imports.get(value);
    if (!resolved) {
      throw new Error(`Unable to resolve ${match[1]} in ${fileName}: ${value}`);
    }
    entries.set(match[1], resolved);
  }
  return entries;
};

const parseStringArray = (fileName: string, exportName: string) => {
  const source = readFileSync(join(APP_STORE_DIR, fileName), "utf8");
  const exportAt = source.indexOf(`export const ${exportName}`);
  if (exportAt === -1) {
    throw new Error(`${fileName} does not export ${exportName}`);
  }
  const endAt = source.indexOf("]", exportAt);
  return Array.from(source.slice(exportAt, endAt).matchAll(/"([^"]+)"/g)).map((match) => match[1]);
};

const sortedEntries = (map: Map<string, string>) =>
  new Map(Array.from(map.entries()).sort(([left], [right]) => left.localeCompare(right)));

const generatedModuleExists = (importPath: string) => {
  const base = join(APP_STORE_DIR, importPath);
  return (
    existsSync(base) ||
    existsSync(`${base}.ts`) ||
    existsSync(`${base}.tsx`) ||
    existsSync(join(base, "index.ts")) ||
    existsSync(join(base, "index.tsx"))
  );
};

const readAppCategories = () => {
  const schema = readFileSync(join(REPO_ROOT, "packages/prisma/schema.prisma"), "utf8");
  const block = schema.match(/enum AppCategories \{([\s\S]*?)\}/);
  if (!block) throw new Error("AppCategories enum not found in the Prisma schema");
  const categories = block[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
  return new Set(categories);
};

const templateIntegrations = () =>
  readdirSync(join(APP_STORE_DIR, "templates"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (integration) =>
        existsSync(join(APP_STORE_DIR, "templates", integration, "config.json")) ||
        existsSync(join(APP_STORE_DIR, "templates", integration, "_metadata.ts"))
    );

const metadataSourceFile = (integration: string) =>
  existsSync(join(APP_STORE_DIR, integration, "config.json")) ? "config.json" : "_metadata.ts";

const metadataImportPath = (integration: string) =>
  `./${integration}/${existsSync(join(APP_STORE_DIR, integration, "config.json")) ? "config.json" : "_metadata"}`;

const readConfigMetadata = (integration: string) => {
  const source = readFileSync(join(APP_STORE_DIR, integration, "config.json"), "utf8");
  const parsed: unknown = JSON.parse(source);
  const validation = AppMetaSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(`Invalid config.json for ${integration}: ${validation.error.message}`);
  }
  return validation.data;
};

type TsMetadata = {
  slug: string;
  dirName: string;
  type: string;
  variant: string;
  categories: string[];
  isOAuth: boolean;
  isAuth: boolean;
  isGlobal: boolean;
  isTemplate: boolean;
  externalLink: boolean;
};

const readTsMetadata = (integration: string): TsMetadata => {
  const source = readFileSync(join(APP_STORE_DIR, integration, "_metadata.ts"), "utf8");
  const literal = (key: string) => {
    const match = source.match(new RegExp(`^  ${key}:\\s*"([^"]+)"`, "m"));
    if (!match) throw new Error(`_metadata.ts for ${integration} does not declare ${key}`);
    return match[1];
  };
  const categories = source.match(/^ {2}categories:\s*\[([^\]]*)\]/m);
  if (!categories) throw new Error(`_metadata.ts for ${integration} does not declare categories`);
  const flag = (key: string) => new RegExp(`\\b${key}:\\s*true\\b`).test(source);

  return {
    slug: literal("slug"),
    dirName: literal("dirName"),
    type: literal("type"),
    variant: literal("variant"),
    categories: Array.from(categories[1].matchAll(/"([^"]+)"/g)).map((match) => match[1]),
    isOAuth: flag("isOAuth"),
    isAuth: flag("isAuth"),
    isGlobal: flag("isGlobal"),
    isTemplate: flag("isTemplate"),
    externalLink: /\bexternalLink:\s*\{/.test(source),
  };
};

const metadataCache = new Map<string, AppMetaType>();
const readNormalizedMetadata = (integration: string) => {
  const cached = metadataCache.get(integration);
  if (cached) return cached;
  const raw = appStoreMetadata[integration as keyof typeof appStoreMetadata];
  const validation = AppMetaSchema.safeParse(raw);
  if (!validation.success) {
    throw new Error(`Invalid normalized metadata for ${integration}: ${validation.error.message}`);
  }
  metadataCache.set(integration, validation.data);
  return validation.data;
};

const inventory = parseInventory(readFileSync(INVENTORY_PATH, "utf8"));
const rows = inventory.rows;
const appCategories = readAppCategories();
const templates = templateIntegrations();
const metadataMap = parseGeneratedMap("apps.metadata.generated.ts", "appStoreMetadata");
const apiHandlers = parseGeneratedMap("apps.server.generated.ts", "apiHandlers");
const appKeysSchemas = parseGeneratedMap("apps.keys-schemas.generated.ts", "appKeysSchemas");
const appDataSchemas = parseGeneratedMap("apps.schemas.generated.ts", "appDataSchemas");
const redirectApps = parseStringArray("redirect-apps.generated.ts", "REDIRECT_APPS");
const serviceMaps = new Map(
  SERVICE_MAP_SPECS.map((spec) => [spec.exportName, parseGeneratedMap(spec.fileName, spec.exportName)])
);
const keySchemaPaths = new Set(appKeysSchemas.values());
const appDataSchemaPaths = new Set(appDataSchemas.values());

describe("app-store integration inventory", () => {
  it("pins the inventory columns, row count and disposition", () => {
    expect(inventory.header).toEqual([...INVENTORY_COLUMNS]);
    expect(rows).toHaveLength(BASELINE_INTEGRATION_COUNT);
    expect(new Set(rows.map((row) => row.integration)).size).toBe(rows.length);

    for (const row of rows) {
      expect(row.contract).toBe("preserve-provider-api");
      expect(["D_APPS", "D_PAYMENTS"]).toContain(row.domain);
      expect(row.destination).toBe(`packages/app-store/${row.integration}`);
      expect(row.metadata.startsWith(`${row.destination}/`)).toBe(true);
      expect(row.enablement_variables).toMatch(/^$|^[A-Z0-9_]+(,[A-Z0-9_]+)*$/);
    }
  });

  it.each(rows)("$integration", (row) => {
    const appDir = join(APP_STORE_DIR, row.integration);
    const listedMetadata = row.metadata.split(",");
    const existingMetadata = ["config.json", "_metadata.ts"]
      .filter((fileName) => existsSync(join(appDir, fileName)))
      .map((fileName) => `${row.destination}/${fileName}`);

    expect(isDirectory(appDir)).toBe(true);
    expect([...listedMetadata].sort()).toEqual(existingMetadata.sort());
    for (const metadataPath of listedMetadata) {
      expect(existsSync(join(REPO_ROOT, metadataPath))).toBe(true);
    }

    const metadata = readNormalizedMetadata(row.integration);
    expect(metadata.dirName).toBe(row.integration);
    expect(metadata.isTemplate).not.toBe(true);
    expect(metadata.slug).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(metadata.type.length).toBeGreaterThan(0);
    expect(AppMetaSchema.shape.variant.safeParse(metadata.variant).success).toBe(true);
    expect(metadata.categories.length).toBeGreaterThan(0);
    expect(new Set(metadata.categories).size).toBe(metadata.categories.length);
    for (const category of metadata.categories) {
      expect(appCategories.has(category), `${row.integration} declares unknown category ${category}`).toBe(
        true
      );
    }
    if (!metadata.variant.startsWith("other")) {
      expect(metadata.categories).toContain(metadata.variant);
    }

    if (row.domain === "D_PAYMENTS") {
      expect(metadata.variant).toBe("payment");
      expect(metadata.categories).toContain("payment");
    } else {
      expect(row.domain).toBe("D_APPS");
      expect(metadata.categories).not.toContain("payment");
    }

    if (existsSync(join(appDir, "config.json"))) {
      const config = readConfigMetadata(row.integration);
      expect(config.dirName ?? config.slug).toBe(row.integration);
    }

    if (existsSync(join(appDir, "_metadata.ts"))) {
      const tsMetadata = readTsMetadata(row.integration);
      expect(tsMetadata.dirName).toBe(row.integration);
      expect(tsMetadata.slug).toBe(metadata.slug);
      expect(tsMetadata.type).toBe(metadata.type);
      expect(tsMetadata.variant).toBe(metadata.variant);
      expect([...tsMetadata.categories].sort()).toEqual([...metadata.categories].sort());
    }

    const sourceText = readFileSync(join(appDir, metadataSourceFile(row.integration)), "utf8");
    if (row.enablementVariables.length > 0) {
      expect(metadataSourceFile(row.integration)).toBe("_metadata.ts");
      expect(sourceText).toMatch(/\binstalled:\s/);
      for (const variable of row.enablementVariables) {
        expect(sourceText).toMatch(new RegExp(`process\\.env\\.${variable}\\b`));
      }
    } else {
      expect(sourceText).not.toContain("process.env");
    }

    const zodSource = existsSync(join(appDir, "zod.ts")) ? readFileSync(join(appDir, "zod.ts"), "utf8") : "";
    const declaresKeySchema = /\bexport const appKeysSchema\b/.test(zodSource);
    const declaresAppDataSchema = /\bexport const appDataSchema\b/.test(zodSource);
    const declaresAuth = metadata.isOAuth === true || metadata.isAuth === true || metadata.isGlobal === true;
    const generatedKeySchema = keySchemaPaths.has(`./${row.integration}/zod`);

    if (zodSource) {
      expect(declaresKeySchema).toBe(true);
      expect(declaresAppDataSchema).toBe(true);
    }
    if (declaresAuth || row.enablementVariables.length > 0) {
      expect(declaresKeySchema, `${row.integration} declares credentials without an appKeysSchema`).toBe(
        true
      );
    }
    expect(generatedKeySchema).toBe(declaresKeySchema);
    expect(appDataSchemaPaths.has(`./${row.integration}/zod`)).toBe(declaresAppDataSchema);

    const hasApiDirectory = isDirectory(join(appDir, "api"));
    expect(apiHandlers.has(row.integration)).toBe(hasApiDirectory);
    if (hasApiDirectory) {
      expect(apiHandlers.get(row.integration)).toBe(`./${row.integration}/api`);
    }

    const catalogOnly = !existsSync(join(appDir, "package.json")) && !existsSync(join(appDir, "index.ts"));
    if (catalogOnly) {
      expect(redirectApps).toContain(row.integration);
      expect(hasApiDirectory).toBe(false);
      for (const [name, serviceMap] of Array.from(serviceMaps.entries())) {
        expect(serviceMap.has(row.integration), `${row.integration} appears in ${name}`).toBe(false);
      }
      for (const directory of ["lib", "pages", "components"]) {
        expect(isDirectory(join(appDir, directory))).toBe(false);
      }
    }

    expect(Boolean(metadata.externalLink)).toBe(redirectApps.includes(row.integration));
    if (metadata.externalLink) {
      expect(metadata.externalLink.url.length).toBeGreaterThan(0);
    }
  });

  it("assigns every integration a unique public slug", () => {
    const slugs = rows.map((row) => readNormalizedMetadata(row.integration).slug);
    expect(new Set(slugs).size).toBe(rows.length);
  });

  it("registers every inventory row and template in the generated metadata map", () => {
    const expected = new Map<string, string>();
    for (const row of rows) {
      expected.set(row.integration, metadataImportPath(row.integration));
    }
    for (const template of templates) {
      expected.set(template, metadataImportPath(`templates/${template}`));
    }

    expect(sortedEntries(metadataMap)).toEqual(sortedEntries(expected));
    for (const importPath of Array.from(metadataMap.values())) {
      expect(generatedModuleExists(importPath), `${importPath} does not resolve`).toBe(true);
    }
  });

  it("declares api handlers only for integrations with an api module", () => {
    const expected = new Map<string, string>();
    for (const row of rows) {
      if (isDirectory(join(APP_STORE_DIR, row.integration, "api"))) {
        expected.set(row.integration, `./${row.integration}/api`);
      }
    }
    for (const template of templates) {
      if (isDirectory(join(APP_STORE_DIR, "templates", template, "api"))) {
        expected.set(template, `./templates/${template}/api`);
      }
    }

    expect(sortedEntries(apiHandlers)).toEqual(sortedEntries(expected));
    for (const importPath of Array.from(apiHandlers.values())) {
      expect(generatedModuleExists(importPath), `${importPath} does not resolve`).toBe(true);
    }
  });

  it("declares service maps only for integrations with the matching service module", () => {
    for (const spec of SERVICE_MAP_SPECS) {
      const generated = serviceMaps.get(spec.exportName);
      if (!generated) throw new Error(`Missing parsed map for ${spec.exportName}`);

      const expected = new Map<string, string>();
      for (const row of rows) {
        if (!existsSync(join(APP_STORE_DIR, row.integration, spec.serviceFile))) continue;
        if (spec.category && !readNormalizedMetadata(row.integration).categories.includes(spec.category)) {
          continue;
        }
        expected.set(row.integration, `./${row.integration}/${spec.serviceFile.replace(/\.ts$/, "")}`);
      }

      expect(sortedEntries(generated), spec.exportName).toEqual(sortedEntries(expected));
      for (const importPath of Array.from(generated.values())) {
        expect(generatedModuleExists(importPath), `${importPath} does not resolve`).toBe(true);
      }
    }
  });

  it("keys app schemas by integration directory, preserving the Stripe app-id alias", () => {
    const expected = new Map<string, string>();
    for (const row of rows) {
      const zodPath = join(APP_STORE_DIR, row.integration, "zod.ts");
      if (!existsSync(zodPath)) continue;
      if (!/\bexport const appKeysSchema\b/.test(readFileSync(zodPath, "utf8"))) continue;
      expected.set(
        row.integration === "stripepayment" ? "stripe" : row.integration,
        `./${row.integration}/zod`
      );
    }
    for (const template of templates) {
      const zodPath = join(APP_STORE_DIR, "templates", template, "zod.ts");
      if (!existsSync(zodPath)) continue;
      if (!/\bexport const appKeysSchema\b/.test(readFileSync(zodPath, "utf8"))) continue;
      expected.set(template, `./templates/${template}/zod`);
    }

    expect(sortedEntries(appKeysSchemas)).toEqual(sortedEntries(expected));
    expect(sortedEntries(appDataSchemas)).toEqual(sortedEntries(expected));

    for (const [key, importPath] of Array.from(appKeysSchemas.entries())) {
      const directory = importPath.match(/^\.\/(?:templates\/)?([^/]+)\/zod$/)?.[1];
      expect(directory, `${importPath} is not an app schema module`).toBeDefined();
      // app-store-cli getAppId() rewrites Stripe's directory to its public app id; keep that alias.
      expect(key).toBe(directory === "stripepayment" ? "stripe" : directory);
    }
  });

  it("classifies catalog-only integrations as external-link redirects without API surface", () => {
    const externalLinkRows = rows
      .filter((row) => Boolean(readNormalizedMetadata(row.integration).externalLink))
      .map((row) => row.integration);
    expect(new Set(redirectApps)).toEqual(new Set(externalLinkRows));

    const catalogOnly = rows
      .filter(
        (row) =>
          !existsSync(join(APP_STORE_DIR, row.integration, "package.json")) &&
          !existsSync(join(APP_STORE_DIR, row.integration, "index.ts"))
      )
      .map((row) => row.integration);
    const redirectsWithoutPackage = redirectApps.filter(
      (integration) =>
        !existsSync(join(APP_STORE_DIR, integration, "package.json")) &&
        !existsSync(join(APP_STORE_DIR, integration, "index.ts"))
    );

    expect(catalogOnly.length).toBeGreaterThan(0);
    expect(new Set(redirectsWithoutPackage)).toEqual(new Set(catalogOnly));
    for (const integration of catalogOnly) {
      expect(apiHandlers.has(integration)).toBe(false);
      for (const [name, serviceMap] of Array.from(serviceMaps.entries())) {
        expect(serviceMap.has(integration), `${integration} appears in ${name}`).toBe(false);
      }
    }
  });
});
