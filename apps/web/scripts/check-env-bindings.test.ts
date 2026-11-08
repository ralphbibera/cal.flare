import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkEnvBindings, evaluateEnvBindings } from "./check-env-bindings";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const allowlistSource = "apps/web/vite.config.mts";

const table = (header: string[], rows: string[][]) =>
  [header.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n");

const inventory = (rows: string[][] = []) => table(["variable", "source", "target", "domain"], rows);

const bindings = (rows: string[][] = []) => table(["variable", "disposition", "target", "evidence"], rows);

const edgeInventory = ["EDGE_CONFIG", "apps/web/proxy.ts", "d1-runtime-config", "D_SHELL"];
const edgeBinding = [
  "EDGE_CONFIG",
  "destination",
  "d1:RuntimeConfig",
  "signup-disabled flag reads RuntimeConfig from D1",
];

const evaluate = ({
  inventoryRows = [],
  bindingRows = [],
  allowlistNames = [],
}: {
  inventoryRows?: string[][];
  bindingRows?: string[][];
  allowlistNames?: string[];
}) =>
  evaluateEnvBindings({
    inventoryTsv: inventory([edgeInventory, ...inventoryRows]),
    bindingsTsv: bindings([edgeBinding, ...bindingRows]),
    allowlistNames,
    allowlistSource,
  });

describe("checkEnvBindings", () => {
  it("accepts the repository inventory, bindings and allowlist", () => {
    expect(checkEnvBindings(repoRoot)).toEqual([]);
  });

  it("reports a D_SHELL variable without a disposition", () => {
    const findings = evaluate({
      inventoryRows: [["FEATURE_FLAG", "packages/lib/constants.ts", "server-binding", "D_SHELL"]],
    });

    expect(findings.join("\n")).toContain("missing disposition for D_SHELL variable FEATURE_FLAG");
  });

  it("reports a public build value missing from the allowlist", () => {
    const findings = evaluate({
      inventoryRows: [["NEXT_PUBLIC_FLAG", "packages/lib/constants.ts", "browser-build", "D_SHELL"]],
      bindingRows: [["NEXT_PUBLIC_FLAG", "public-build", "allowlist:NEXT_PUBLIC_FLAG", ""]],
    });

    expect(findings.join("\n")).toContain("public build value NEXT_PUBLIC_FLAG is missing");
  });

  it("accepts an allowlist entry with a public-build disposition and no inventory row", () => {
    expect(
      evaluate({
        bindingRows: [["NEXT_PUBLIC_DEPENDENCY", "public-build", "allowlist:NEXT_PUBLIC_DEPENDENCY", ""]],
        allowlistNames: ["NEXT_PUBLIC_DEPENDENCY"],
      })
    ).toEqual([]);
  });

  it("reports an allowlist entry that is not expected public build output", () => {
    const findings = evaluate({ allowlistNames: ["NEXT_PUBLIC_STRAY"] });

    expect(findings.join("\n")).toContain("NEXT_PUBLIC_STRAY is not an expected public build value");
  });

  it("reports test-support on a variable read by product source", () => {
    const findings = evaluate({
      inventoryRows: [["FEATURE_TESTS", "packages/lib/constants.ts", "server-binding", "D_SHELL"]],
      bindingRows: [["FEATURE_TESTS", "unsupported", "none:test-support", "assumed test only"]],
    });

    expect(findings.join("\n")).toContain("FEATURE_TESTS is not test or script only");
  });

  it("does not require an example-app-only browser variable in the allowlist", () => {
    expect(
      evaluate({
        inventoryRows: [
          [
            "NEXT_PUBLIC_EXAMPLE_ONLY",
            "packages/platform/examples/base/playwright.config.ts",
            "browser-build",
            "D_API",
          ],
        ],
      })
    ).toEqual([]);
  });

  it("reports a browser-build variable that is not a public build value", () => {
    const findings = evaluate({
      inventoryRows: [["NEXT_PUBLIC_FLAG", "packages/lib/constants.ts", "browser-build", "D_SHELL"]],
      bindingRows: [["NEXT_PUBLIC_FLAG", "binding", "var:NEXT_PUBLIC_FLAG", ""]],
    });

    expect(findings.join("\n")).toContain("NEXT_PUBLIC_FLAG is a browser-build reference");
  });

  it("reports a server variable marked as a public build value", () => {
    const findings = evaluate({
      inventoryRows: [["FEATURE_FLAG", "packages/lib/constants.ts", "server-binding", "D_SHELL"]],
      bindingRows: [["FEATURE_FLAG", "public-build", "allowlist:FEATURE_FLAG", ""]],
      allowlistNames: ["FEATURE_FLAG"],
    });

    expect(findings.join("\n")).toContain(
      "FEATURE_FLAG is not a browser-build reference but is public-build"
    );
  });

  it("reports a missing EDGE_CONFIG D1 replacement", () => {
    const findings = evaluateEnvBindings({
      inventoryTsv: inventory(),
      bindingsTsv: bindings(),
      allowlistNames: [],
      allowlistSource,
    });

    expect(findings.join("\n")).toContain("missing EDGE_CONFIG row recording the D1 replacement");
    expect(findings.join("\n")).toContain("EDGE_CONFIG must record d1:RuntimeConfig");
  });
});
