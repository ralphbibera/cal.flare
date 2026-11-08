import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH = "docs/porting/inventory/environment.tsv";
const BINDINGS_PATH = "docs/porting/inventory/config-bindings.tsv";
const INVENTORY_HEADER = ["variable", "source", "target", "domain"];
const BINDINGS_HEADER = ["variable", "disposition", "target", "evidence"];
const ALLOWLIST_CANDIDATES = ["apps/web/scripts/client-process.ts", "apps/web/vite.config.mts"];
const TEST_OR_SCRIPT_SOURCE =
  /(^|\/)(playwright|test|tests|__tests__|testing|scripts|app-store-cli|examples)\/|\.(test|spec|e2e|integration-test)\.(ts|tsx|js|jsx)$/;
const EXAMPLE_SOURCE = /^packages\/platform\/examples\//;
const EDGE_CONFIG_TARGET = "d1:RuntimeConfig";

const DISPOSITIONS = [
  "binding",
  "secret",
  "public-build",
  "dynamic-lookup",
  "destination",
  "unsupported",
] as const;

type Disposition = (typeof DISPOSITIONS)[number];

type Row = {
  variable: string;
  fields: string[];
};

type InventoryRow = Row & {
  source: string;
  target: string;
  domain: string;
};

type BindingRow = Row & {
  disposition: Disposition;
  target: string;
  evidence: string;
};

type EnvBindingInput = {
  inventoryTsv: string;
  bindingsTsv: string;
  allowlistNames: readonly string[];
  allowlistSource: string;
};

function parseTable(tsv: string, header: string[], file: string): { rows: Row[]; findings: string[] } {
  const findings: string[] = [];
  const lines = tsv.split("\n").map((line) => line.replace(/\r$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.shift() !== header.join("\t")) {
    return { rows: [], findings: [`${file}: expected header ${header.join("\\t")}`] };
  }
  const rows: Row[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields.length !== header.length) {
      findings.push(`${file}:${index + 2}: expected ${header.length} fields, found ${fields.length}`);
      continue;
    }
    rows.push({ variable: fields[0], fields });
  }
  return { rows, findings };
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort(compare);
}

function difference(left: Iterable<string>, right: Set<string>): string[] {
  return uniqueSorted(Array.from(left).filter((value) => !right.has(value)));
}

function isDisposition(value: string): value is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(value);
}

function targetMismatch(disposition: Disposition, variable: string, target: string): boolean {
  switch (disposition) {
    case "binding":
      return target !== `var:${variable}`;
    case "secret":
      return target !== `secret:${variable}`;
    case "public-build":
      return target !== `allowlist:${variable}`;
    case "dynamic-lookup":
      return !target.startsWith("dynamic:");
    case "destination":
      return !/^(d1|queue|do):/.test(target);
    case "unsupported":
      return !target.startsWith("none:");
  }
}

function isTestOrScriptSource(source: string): boolean {
  return TEST_OR_SCRIPT_SOURCE.test(source);
}

function readPublicBuildEnvironment(repoRoot: string): { source: string; names: string[] } | null {
  for (const candidate of ALLOWLIST_CANDIDATES) {
    const absolute = path.join(repoRoot, candidate);
    if (!existsSync(absolute)) continue;
    const setLiteral = readFileSync(absolute, "utf8").match(/new Set\(\[([\s\S]*?)\]\)/);
    if (!setLiteral) return null;
    return {
      source: candidate,
      names: Array.from(setLiteral[1].matchAll(/"([A-Z0-9_]+)"/g), (match) => match[1]),
    };
  }
  return null;
}

function parseBindings(
  rows: Row[],
  dshellRows: InventoryRow[]
): { bindings: Map<string, BindingRow>; findings: string[] } {
  const bindings = new Map<string, BindingRow>();
  const findings: string[] = [];
  for (const row of rows) {
    const [, rawDisposition, target, evidence] = row.fields;
    if (bindings.has(row.variable)) {
      findings.push(`${BINDINGS_PATH}: duplicate row for ${row.variable}`);
      continue;
    }
    if (!isDisposition(rawDisposition)) {
      findings.push(`${BINDINGS_PATH}: ${row.variable} has unknown disposition ${rawDisposition}`);
      continue;
    }
    if (target === "" || targetMismatch(rawDisposition, row.variable, target)) {
      findings.push(`${BINDINGS_PATH}: ${row.variable} target ${target} does not match ${rawDisposition}`);
      continue;
    }
    if (
      rawDisposition !== "binding" &&
      rawDisposition !== "secret" &&
      rawDisposition !== "public-build" &&
      evidence === ""
    ) {
      findings.push(`${BINDINGS_PATH}: ${row.variable} needs evidence for ${rawDisposition}`);
    }
    if (rawDisposition === "unsupported" && target === "none:test-support") {
      const sources = dshellRows
        .filter((entry) => entry.variable === row.variable)
        .map((entry) => entry.source);
      if (!(sources.length > 0 && sources.every(isTestOrScriptSource))) {
        findings.push(
          `${BINDINGS_PATH}: ${row.variable} is not test or script only but is marked test-support`
        );
      }
    }
    bindings.set(row.variable, { ...row, disposition: rawDisposition, target, evidence });
  }
  return { bindings, findings };
}

export function evaluateEnvBindings({
  inventoryTsv,
  bindingsTsv,
  allowlistNames,
  allowlistSource,
}: EnvBindingInput): string[] {
  const inventoryTable = parseTable(inventoryTsv, INVENTORY_HEADER, INVENTORY_PATH);
  const bindingsTable = parseTable(bindingsTsv, BINDINGS_HEADER, BINDINGS_PATH);
  const findings = [...inventoryTable.findings, ...bindingsTable.findings];

  const inventory: InventoryRow[] = inventoryTable.rows.map((row) => ({
    ...row,
    source: row.fields[1],
    target: row.fields[2],
    domain: row.fields[3],
  }));
  const dshellRows = inventory.filter((row) => row.domain === "D_SHELL");
  const dshellVariables = uniqueSorted(dshellRows.map((row) => row.variable));
  const dshellSet = new Set(dshellVariables);

  const { bindings, findings: bindingFindings } = parseBindings(bindingsTable.rows, dshellRows);
  findings.push(...bindingFindings);

  const allowlistSet = new Set(allowlistNames);
  const bindingVariables = new Set(bindings.keys());

  for (const variable of difference(dshellVariables, bindingVariables)) {
    findings.push(`${BINDINGS_PATH}: missing disposition for D_SHELL variable ${variable}`);
  }
  const allowlistOnly = difference(bindingVariables, dshellSet);
  for (const variable of allowlistOnly) {
    if (!allowlistSet.has(variable)) {
      findings.push(`${BINDINGS_PATH}: ${variable} is not a D_SHELL variable and not allowlisted`);
    }
    if (bindings.get(variable)?.disposition !== "public-build") {
      findings.push(`${BINDINGS_PATH}: allowlist-only ${variable} must use public-build`);
    }
  }

  const publicBuildRows = new Set(
    Array.from(bindings.values())
      .filter((row) => row.disposition === "public-build")
      .map((row) => row.variable)
  );
  for (const variable of difference(publicBuildRows, allowlistSet)) {
    findings.push(`${allowlistSource}: public build value ${variable} is missing`);
  }

  const browserBuild = uniqueSorted(
    inventory.filter((row) => row.target === "browser-build").map((row) => row.variable)
  );
  const browserBuildSet = new Set(browserBuild);
  for (const variable of browserBuild) {
    if (!dshellSet.has(variable)) continue;
    const disposition = bindings.get(variable)?.disposition;
    if (disposition !== "public-build" && disposition !== "unsupported") {
      findings.push(
        `${BINDINGS_PATH}: ${variable} is a browser-build reference and must be public-build or unsupported`
      );
    }
  }
  for (const row of Array.from(bindings.values())) {
    if (
      row.disposition === "public-build" &&
      dshellSet.has(row.variable) &&
      !browserBuildSet.has(row.variable)
    ) {
      findings.push(`${BINDINGS_PATH}: ${row.variable} is not a browser-build reference but is public-build`);
    }
  }
  const exampleOnly = new Set(
    browserBuild.filter((variable) => {
      const sources = inventory.filter((row) => row.variable === variable);
      return sources.length > 0 && sources.every((row) => EXAMPLE_SOURCE.test(row.source));
    })
  );
  const dshellNonPublic = new Set(
    dshellVariables.filter((variable) => bindings.get(variable)?.disposition !== "public-build")
  );
  const expected = new Set(
    browserBuild.filter((variable) => !exampleOnly.has(variable) && !dshellNonPublic.has(variable))
  );
  for (const variable of allowlistOnly) expected.add(variable);

  for (const variable of difference(expected, allowlistSet)) {
    findings.push(`${allowlistSource}: expected public build value ${variable} is missing`);
  }
  for (const variable of difference(allowlistSet, expected)) {
    findings.push(`${allowlistSource}: ${variable} is not an expected public build value`);
  }

  const edgeConfig = inventory.find((row) => row.variable === "EDGE_CONFIG" && row.domain === "D_SHELL");
  if (!edgeConfig) {
    findings.push(`${INVENTORY_PATH}: missing EDGE_CONFIG row recording the D1 replacement`);
  } else if (edgeConfig.target !== "d1-runtime-config") {
    findings.push(`${INVENTORY_PATH}: EDGE_CONFIG target must be d1-runtime-config`);
  }
  const edgeBinding = bindings.get("EDGE_CONFIG");
  if (
    !edgeBinding ||
    edgeBinding.disposition !== "destination" ||
    edgeBinding.target !== EDGE_CONFIG_TARGET
  ) {
    findings.push(`${BINDINGS_PATH}: EDGE_CONFIG must record ${EDGE_CONFIG_TARGET}`);
  }

  return findings;
}

export function checkEnvBindings(repoRoot: string): string[] {
  const inventoryTsv = readFileSync(path.join(repoRoot, INVENTORY_PATH), "utf8");
  const bindingsTsv = readFileSync(path.join(repoRoot, BINDINGS_PATH), "utf8");
  const allowlist = readPublicBuildEnvironment(repoRoot);
  if (!allowlist) {
    return [`${ALLOWLIST_CANDIDATES.join(" or ")}: public build allowlist not found`];
  }
  return evaluateEnvBindings({
    inventoryTsv,
    bindingsTsv,
    allowlistNames: allowlist.names,
    allowlistSource: allowlist.source,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const findings = checkEnvBindings(repoRoot);
  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exit(1);
  }
  console.log("environment inventory and config bindings are consistent");
}
