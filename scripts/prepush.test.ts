import { describe, expect, it } from "vitest";
import type { Git, PushRef } from "./prepush";
import {
  buildSteps,
  collectChanges,
  countTestFiles,
  isDeletion,
  isDocsOrLockfileOnly,
  parsePushLines,
  selectBase,
  toAbsolutePaths,
} from "./prepush";

const ZERO = "0".repeat(40);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const MERGE_BASE = "d".repeat(40);

const ref = (overrides: Partial<PushRef> = {}): PushRef => ({
  localRef: "refs/heads/feature",
  localSha: SHA_A,
  remoteRef: "refs/heads/feature",
  remoteSha: ZERO,
  ...overrides,
});

// Fake git: answers from a table keyed by the joined args and returns undefined for unknown commands.
const fakeGit =
  (answers: Record<string, string>): Git =>
  (args) =>
    answers[args.join(" ")];

describe("parsePushLines", () => {
  it("parses one record per line", () => {
    const stdin = `refs/heads/a ${SHA_A} refs/heads/a ${ZERO}\nrefs/heads/b ${SHA_B} refs/heads/b ${SHA_C}\n`;
    expect(parsePushLines(stdin)).toEqual([
      { localRef: "refs/heads/a", localSha: SHA_A, remoteRef: "refs/heads/a", remoteSha: ZERO },
      { localRef: "refs/heads/b", localSha: SHA_B, remoteRef: "refs/heads/b", remoteSha: SHA_C },
    ]);
  });

  it("returns nothing for empty input and ignores malformed lines", () => {
    expect(parsePushLines("")).toEqual([]);
    expect(parsePushLines("refs/heads/a only-two-fields\n")).toEqual([]);
  });
});

describe("isDeletion", () => {
  it("treats an all-zero local sha as a deletion", () => {
    expect(isDeletion(ref({ localSha: ZERO }))).toBe(true);
    expect(isDeletion(ref())).toBe(false);
  });
});

describe("selectBase", () => {
  it("uses the remote sha when it exists locally", () => {
    const git = fakeGit({ [`cat-file -e ${SHA_B}^{commit}`]: "" });
    expect(selectBase(ref({ remoteSha: SHA_B }), git)).toBe(SHA_B);
  });

  it("falls back to the merge-base with origin/main for a new branch", () => {
    const git = fakeGit({ [`merge-base ${SHA_A} origin/main`]: MERGE_BASE });
    expect(selectBase(ref(), git)).toBe(MERGE_BASE);
  });

  it("falls back to the merge-base when the remote sha is not fetched locally", () => {
    const git = fakeGit({ [`merge-base ${SHA_A} origin/main`]: MERGE_BASE });
    expect(selectBase(ref({ remoteSha: SHA_B }), git)).toBe(MERGE_BASE);
  });
});

describe("collectChanges", () => {
  it("unions the changed files of every ref and uses a common base", () => {
    const git = fakeGit({
      [`merge-base ${SHA_A} origin/main`]: MERGE_BASE,
      [`cat-file -e ${SHA_C}^{commit}`]: "",
      [`diff --name-only --diff-filter=ACMR ${MERGE_BASE} ${SHA_A}`]: "a.ts\nshared.ts",
      [`diff --name-only --diff-filter=ACMR ${SHA_C} ${SHA_B}`]: "shared.ts\nb.ts",
      [`merge-base --octopus ${MERGE_BASE} ${SHA_C}`]: MERGE_BASE,
    });
    const refs = [ref(), ref({ localRef: "refs/heads/next", localSha: SHA_B, remoteSha: SHA_C })];
    expect(collectChanges(refs, git)).toEqual({
      files: ["a.ts", "b.ts", "shared.ts"],
      commonBase: MERGE_BASE,
    });
  });

  it("fails when no base can be found", () => {
    expect(() => collectChanges([ref()], fakeGit({}))).toThrow("Cannot find a base");
  });
});

describe("isDocsOrLockfileOnly", () => {
  it("is true for markdown, docs/ and lockfiles", () => {
    expect(
      isDocsOrLockfileOnly(["README.md", "docs/porting/plan.txt", "bun.lock", "apps/web/bun.lock"])
    ).toBe(true);
  });

  it("is false as soon as one code file changed", () => {
    expect(isDocsOrLockfileOnly(["README.md", "packages/lib/a.ts"])).toBe(false);
  });
});

describe("toAbsolutePaths", () => {
  it("resolves ts, tsx and js files against the repo root and drops everything else", () => {
    expect(
      toAbsolutePaths(["packages/lib/a.ts", "apps/web/b.tsx", "c.js", "d.json", "e.md"], "/repo")
    ).toEqual(["/repo/packages/lib/a.ts", "/repo/apps/web/b.tsx", "/repo/c.js"]);
  });
});

describe("buildSteps", () => {
  const args = { base: MERGE_BASE, root: "/repo", testReportPath: "/tmp/report.json" };

  it("runs biome, type-check and related tests in order", () => {
    const steps = buildSteps({ ...args, files: ["packages/lib/a.ts", "package.json"] });
    expect(steps.map((step) => step.name)).toEqual(["biome", "type-check", "related-tests"]);
    expect(steps[0].command).toContain("package.json");
    expect(steps[1].command).toContain(`--filter=...[${MERGE_BASE}]`);
    expect(steps[1].command).toContain("--filter=@calcom/web");
    expect(steps[2].command).toContain("/repo/packages/lib/a.ts");
    expect(steps[2].command).not.toContain("package.json");
    expect(steps[2].env).toEqual({ TZ: "UTC" });
  });

  it("omits the test step when no changed file can have related tests", () => {
    const steps = buildSteps({ ...args, files: ["packages/prisma/schema.prisma"] });
    expect(steps.map((step) => step.name)).toEqual(["type-check"]);
    expect(steps[0].command).not.toContain("--filter=@calcom/web");
  });
});

describe("countTestFiles", () => {
  it("reads the suite count from a vitest json report", () => {
    expect(countTestFiles('{"numTotalTestSuites":3}')).toBe(3);
    expect(countTestFiles('{"numTotalTestSuites":0}')).toBe(0);
    expect(countTestFiles("{}")).toBe(0);
  });
});
