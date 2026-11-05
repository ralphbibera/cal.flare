import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { getDMMF } from "@prisma/internals";
import { z } from "zod";
import { ErrorCode } from "../lib/errorCodes";
import { ErrorWithCode } from "../lib/errors";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const prismaPackage = z.object({ version: z.string() }).parse(require("prisma/package.json"));
const schemaUrl = new URL("./schema.prisma", import.meta.url);
const migrationsUrl = new URL("./migrations-d1/", import.meta.url);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const dateDefault = "(strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))";

// Rewrites must never touch quoted defaults or documentation containing schema syntax.
function outsideLiterals(source: string, rewrite: (text: string) => string) {
  let end = 0;
  let result = "";
  for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
    result += rewrite(source.slice(end, match.index)) + match[0];
    end = match.index + match[0].length;
  }
  return result + rewrite(source.slice(end));
}

async function generateD1Domain() {
  const source = await readFile(schemaUrl, "utf8");
  const metadata = (await getDMMF({ datamodel: source })).datamodel;
  const modelNames = new Set([...source.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]));
  const models = metadata.models.filter((model) => modelNames.has(model.name));
  const enums = new Map(
    metadata.enums.map((item) => [item.name, item.values.map((v) => v.dbName ?? v.name)])
  );
  const listFields = models.flatMap((model) =>
    model.fields.filter((field) => field.isList && field.kind !== "object").map((field) => ({ model, field }))
  );
  const header =
    'datasource db {\n  provider = "sqlite"\n  url = "file:unused.db"\n}\ngenerator client {\n  provider = "prisma-client"\n  previewFeatures = ["views"]\n}\n';
  let currentModel = "";
  const body = source
    .replace(/^(?:datasource|generator) \w+ \{[\s\S]*?^\}/gm, "")
    .split("\n")
    .map((line) => {
      const declaration = /^(?:model|view|enum) (\w+) \{/.exec(line);
      if (declaration) currentModel = declaration[1];
      const model = models.find((item) => item.name === currentModel);
      const fieldName = /^\s+(\w+)\s+/.exec(line)?.[1];
      const field = model?.fields.find((item) => item.name === fieldName);
      if (!field) return line;
      return outsideLiterals(line, (text) => {
        let result = text.replace(/\s+@db\.\w+(?:\([^)]*\))?/g, "");
        // PG scalar-list columns are nullable with no SQL default, despite required client arrays.
        if (field.isList && field.kind !== "object")
          result = result.replace(/^(\s+\w+\s+)\w+\[\]/, "$1Json?");
        if (field.type === "DateTime") {
          result = result.replace(/@default\(now\(\)\)/, `@default(dbgenerated("${dateDefault}"))`);
        }
        return result;
      });
    })
    .join("\n");
  const candidate = `${header}${body}`;
  const holiday = /^model HolidayCache \{[\s\S]*?^\}/m.exec(candidate)?.[0];
  if (!holiday) throw new ErrorWithCode(ErrorCode.BadRequest, "Missing authoritative HolidayCache model");
  const temporary = await mkdtemp(join(tmpdir(), "calflare-d1-domain-"));
  try {
    const candidatePath = join(temporary, "domain.prisma");
    const baselinePath = join(temporary, "holiday.prisma");
    await writeFile(candidatePath, candidate);
    await writeFile(baselinePath, header + holiday);
    const cli = require.resolve("prisma/build/index.js");
    const diff = async (from: string[]) => {
      const { stdout } = await execute(
        process.env.npm_node_execpath || "node",
        [cli, "migrate", "diff", ...from, "--to-schema-datamodel", candidatePath, "--script"],
        { cwd: temporary, maxBuffer: 16 * 1024 * 1024 }
      );
      return stdout;
    };
    const oracle = await diff(["--from-empty"]);
    const delta = await diff(["--from-schema-datamodel", baselinePath]);
    const byTable = new Map(models.map((model) => [model.dbName ?? model.name, model]));
    let table = "";
    const sql = delta
      .split("\n")
      .map((line) => {
        const declaration = /^CREATE TABLE "([^"]+)"/.exec(line);
        if (declaration) table = declaration[1];
        const fieldName = /^ {4}"([^"]+)" /.exec(line)?.[1];
        const field = byTable.get(table)?.fields.find((item) => (item.dbName ?? item.name) === fieldName);
        if (!field) return line;
        // SQLite's JSONB declaration has NUMERIC affinity and coerces raw JSON number text.
        if (field.type === "Json" || field.isList) line = line.replace(/^( {4}"[^"]+" )JSONB\b/, "$1TEXT");
        if (field.isList) return line;
        const column = quote(field.dbName ?? field.name);
        const values = enums.get(field.type);
        let check = values ? `${column} IN (${values.map(literal).join(", ")})` : undefined;
        if (field.type === "Json") check = `json_valid(${column})`;
        if (field.type === "Int")
          check = `typeof(${column}) = 'integer' AND ${column} BETWEEN -2147483648 AND 2147483647`;
        if (field.type === "Boolean") check = `${column} IN (0, 1)`;
        if (!check) return line;
        const comma = line.endsWith(",") ? "," : "";
        return `${line.slice(0, line.length - comma.length)} CHECK (${column} IS NULL OR (${check}))${comma}`;
      })
      .join("\n");
    const triggers = listFields
      .flatMap(({ model, field }) => {
        const tableName = model.dbName ?? model.name;
        const column = quote(field.dbName ?? field.name);
        const value = `NEW.${column}`;
        const values = enums.get(field.type);
        const invalid = values
          ? `type <> 'text' OR value NOT IN (${values.map(literal).join(", ")})`
          : field.type === "Int"
            ? "type <> 'integer' OR value NOT BETWEEN -2147483648 AND 2147483647"
            : "type <> 'text'";
        return ["INSERT", "UPDATE"].map(
          (operation) => `CREATE TRIGGER ${quote(`${tableName}_${field.name}_${operation}_array`)}
BEFORE ${operation} ON ${quote(tableName)} WHEN ${value} IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT json_valid(${value}) THEN RAISE(ABORT, 'invalid list JSON')
        WHEN json_type(${value}) <> 'array' THEN RAISE(ABORT, 'expected list array') END;
    SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(${value}) WHERE ${invalid})
        THEN RAISE(ABORT, 'invalid list element') END;
END;`
        );
      })
      .join("\n\n");
    const hash = createHash("sha256").update(source).digest("hex");
    const provenance = `-- Generated by bun run --cwd packages/prisma generate-d1-domain. Do not edit.\n-- Source schema SHA-256: ${hash}; Prisma ${prismaPackage.version}.\n-- HolidayCache belongs to 0001. Views/denormalization/membership effects follow separately.\n`;
    // beta.27 submits each file as one D1 statement, limited to 100 KB. Keep complete SQL units.
    const chunks: string[] = [];
    for (const unit of `${sql}\n${triggers}\n`.split(
      /(?=^-- CreateTable|^-- CreateIndex|^CREATE TRIGGER)/m
    )) {
      const last = chunks.length - 1;
      if (last < 0 || Buffer.byteLength(provenance + chunks[last] + unit) > 90_000) chunks.push(unit);
      else chunks[last] += unit;
    }
    const migrations = chunks.map((chunk, index) => ({
      name: `${String(index + 2).padStart(4, "0")}_domain_tables.sql`,
      sql: provenance + chunk.trimEnd() + "\n",
    }));
    return {
      migrations,
      oracle,
      candidate,
      models,
      enums,
      listFields,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function domainSQLBody(sql: string, versions: readonly string[]): string {
  const header =
    /^-- Generated by bun run --cwd packages\/prisma generate-d1-domain\. Do not edit\.\n-- Source schema SHA-256: [a-f0-9]{64}; Prisma ([\d.]+)\.\n/;
  const version = header.exec(sql)?.[1];
  if (!version || !versions.includes(version))
    throw new ErrorWithCode(ErrorCode.BadRequest, "Invalid D1 domain SQL provenance");
  // Tool upgrades may reproduce the same SQL without changing its original migration history.
  return sql.replace(/^(-- Source schema SHA-256: [a-f0-9]{64}; Prisma )[\d.]+\.$/m, "$1<version>.");
}

async function persistD1Domain({
  migrations,
  check = false,
  directory = migrationsUrl,
}: {
  migrations: Awaited<ReturnType<typeof generateD1Domain>>["migrations"];
  check?: boolean;
  directory?: URL;
}): Promise<void> {
  const missing: { url: URL; sql: string }[] = [];
  for (const migration of migrations) {
    const generated = domainSQLBody(migration.sql, [prismaPackage.version]);
    const url = new URL(migration.name, directory);
    let existing: string;
    try {
      existing = await readFile(url, "utf8");
    } catch (error) {
      if (!check && error instanceof Error && "code" in error && error.code === "ENOENT") {
        missing.push({ url, sql: migration.sql });
        continue;
      }
      throw error;
    }
    if (generated !== domainSQLBody(existing, ["6.16.1", prismaPackage.version]))
      throw new ErrorWithCode(
        ErrorCode.BadRequest,
        "D1 domain SQL differs from source generation; append a reviewed migration instead of overwriting history"
      );
  }
  for (const { url, sql } of missing) await writeFile(url, sql, { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: "boolean" } }, strict: true });
  const { migrations } = await generateD1Domain();
  await persistD1Domain({ migrations, check: values.check });
}

export { generateD1Domain, persistD1Domain };
