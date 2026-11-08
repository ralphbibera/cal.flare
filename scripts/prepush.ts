import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface Step {
  name: string;
  command: string[];
  env?: Record<string, string>;
}

// Returns trimmed stdout, or undefined when git exits non-zero.
export type Git = (args: string[]) => string | undefined;

const ZERO_SHA = /^0+$/;
const BIOME_EXTENSIONS = /\.(?:[cm]?[jt]sx?|json|jsonc|css|graphql)$/;
const TEST_SOURCE_EXTENSIONS = /\.(?:tsx?|js)$/;
const DOCS_FILE = /(?:\.md$|^docs\/)/;
const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
// Unbounded turbo and vitest fan-out started ~20 Node processes per push, and parallel agent pushes exhausted a 16 GB machine.
const DEFAULT_CONCURRENCY = 2;
const LOCK_POLL_MS = 2000;

export function parsePushLines(stdin: string): PushRef[] {
  const refs: PushRef[] = [];
  for (const line of stdin.split("\n")) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || !remoteRef || !remoteSha) continue;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

export function isDeletion(ref: PushRef): boolean {
  return ZERO_SHA.test(ref.localSha);
}

export function selectBase(ref: PushRef, git: Git): string | undefined {
  const remoteKnownLocally =
    !ZERO_SHA.test(ref.remoteSha) && git(["cat-file", "-e", `${ref.remoteSha}^{commit}`]) !== undefined;
  if (remoteKnownLocally) return ref.remoteSha;
  return git(["merge-base", ref.localSha, "origin/main"]);
}

export interface Changes {
  files: string[];
  // A merge-base of all per-ref bases, so one diff against it covers every pushed ref.
  commonBase: string;
}

export function collectChanges(refs: PushRef[], git: Git): Changes {
  const files = new Set<string>();
  const bases = new Set<string>();
  for (const ref of refs) {
    const base = selectBase(ref, git);
    if (!base) {
      throw new Error(`Cannot find a base for ${ref.localRef} (is origin/main fetched?)`);
    }
    bases.add(base);
    const diff = git(["diff", "--name-only", "--diff-filter=ACMR", base, ref.localSha]);
    if (diff === undefined) throw new Error(`git diff failed for ${base}..${ref.localSha}`);
    for (const file of diff.split("\n")) if (file) files.add(file);
  }
  const baseList = [...bases];
  const commonBase = baseList.length === 1 ? baseList[0] : git(["merge-base", "--octopus", ...baseList]);
  if (!commonBase) throw new Error("Cannot find a common base for the pushed refs");
  return { files: [...files].sort(), commonBase };
}

export function isDocsOrLockfileOnly(files: string[]): boolean {
  return files.every((file) => DOCS_FILE.test(file) || LOCKFILES.has(path.posix.basename(file)));
}

export function toAbsolutePaths(files: string[], root: string): string[] {
  return files.filter((file) => TEST_SOURCE_EXTENSIONS.test(file)).map((file) => path.resolve(root, file));
}

export function buildSteps({
  files,
  base,
  root,
  testReportPath,
  concurrency = DEFAULT_CONCURRENCY,
}: {
  files: string[];
  base: string;
  root: string;
  testReportPath: string;
  concurrency?: number;
}): Step[] {
  const steps: Step[] = [];
  const biomeFiles = files.filter((file) => BIOME_EXTENSIONS.test(file));
  if (biomeFiles.length > 0) {
    steps.push({
      name: "biome",
      command: [
        "bunx",
        "biome",
        // Matches CI's `turbo lint` (biome lint); `check` would also fail on old import order in touched files.
        "lint",
        "--no-errors-on-unmatched",
        "--files-ignore-unknown=true",
        "--diagnostic-level=error",
        ...biomeFiles,
      ],
    });
  }
  // vitest related finds nothing and exits 0 for relative paths, so only absolute ones are passed.
  const sourceFiles = toAbsolutePaths(files, root);
  // @calcom/web type-checks most packages/** sources through path aliases without declaring them as
  // workspace dependencies, so turbo's dependents filter alone never selects it for a package change.
  const webFilter = sourceFiles.length > 0 ? ["--filter=@calcom/web"] : [];
  steps.push({
    name: "type-check",
    command: [
      "bunx",
      "turbo",
      "run",
      "type-check:ci",
      "--log-prefix=none",
      `--concurrency=${concurrency}`,
      `--filter=...[${base}]`,
      ...webFilter,
    ],
  });
  if (sourceFiles.length > 0) {
    steps.push({
      name: "related-tests",
      command: [
        "bunx",
        "vitest",
        "related",
        "--run",
        "--project",
        "!PackagedEmbedTests",
        `--maxWorkers=${concurrency}`,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${testReportPath}`,
        ...sourceFiles,
      ],
      env: { TZ: "UTC" },
    });
  }
  return steps;
}

export function countTestFiles(report: string): number {
  const parsed: unknown = JSON.parse(report);
  if (typeof parsed !== "object" || parsed === null || !("numTotalTestSuites" in parsed)) return 0;
  return typeof parsed.numTotalTestSuites === "number" ? parsed.numTotalTestSuites : 0;
}

export interface LockDeps {
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => void;
  onWait: (holder: number) => void;
}

/**
 * Serializes pre-push runs across every worktree sharing this git common dir, so concurrent pushes
 * queue instead of stacking type checks and test forks. A lock left by a dead process is taken over.
 */
export function acquireLock(lockDir: string, deps: LockDeps): () => void {
  const pidFile = path.join(lockDir, "pid");
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(pidFile, String(process.pid));
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const holder = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : Number.NaN;
    // A missing pid file means the holder is between mkdir and write; wait for it rather than steal.
    if (Number.isInteger(holder) && holder > 0 && !deps.isAlive(holder)) {
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (!announced) {
      deps.onWait(holder);
      announced = true;
    }
    deps.sleep(LOCK_POLL_MS);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const activeGroups = new Set<number>();

// Steps run in their own process group so leftover tsc, vitest forks or workerd die with the step.
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}

function killActiveGroups(): void {
  for (const pid of activeGroups) killGroup(pid);
  activeGroups.clear();
}

const BYPASS_HINT =
  "Bypass with SKIP_PREPUSH=1 git push ... or git push --no-verify (CI is still the real gate).";

function createGit(cwd: string): Git {
  return (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) return undefined;
    return result.stdout.trim();
  };
}

function formatSeconds(startedAt: number): string {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

async function runStep(step: Step, cwd: string): Promise<boolean> {
  console.log(`\n[prepush] ${step.name}: ${step.command.join(" ")}`);
  const startedAt = performance.now();
  const child = spawn(step.command[0], step.command.slice(1), {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...step.env },
    detached: true,
  });
  const pid = child.pid;
  if (pid !== undefined) activeGroups.add(pid);
  const passed = await new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
  if (pid !== undefined) {
    killGroup(pid);
    activeGroups.delete(pid);
  }
  console.log(`[prepush] ${step.name} ${passed ? "passed" : "FAILED"} in ${formatSeconds(startedAt)}`);
  return passed;
}

function parseConcurrency(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONCURRENCY;
}

async function main(): Promise<number> {
  if (process.env.SKIP_PREPUSH === "1") {
    console.log("[prepush] skipped: SKIP_PREPUSH=1");
    return 0;
  }

  const rootGit = createGit(process.cwd());
  const root = rootGit(["rev-parse", "--show-toplevel"]);
  const gitDir = rootGit(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = rootGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!root || !gitDir || !commonDir) {
    console.error("[prepush] not inside a git repository");
    return 1;
  }
  const git = createGit(root);

  if (existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    console.log("[prepush] skipped: merge in progress");
    return 0;
  }

  // git passes <remote> <url> to the hook; a manual run has neither and checks HEAD against origin/main.
  const isHook = process.argv.length > 2;
  let refs: PushRef[];
  if (isHook) {
    refs = parsePushLines(readFileSync(0, "utf8"));
  } else {
    const head = git(["rev-parse", "HEAD"]);
    if (!head) {
      console.error("[prepush] cannot resolve HEAD");
      return 1;
    }
    refs = [{ localRef: "HEAD", localSha: head, remoteRef: "refs/heads/main", remoteSha: "0".repeat(40) }];
  }

  const pushed = refs.filter((ref) => !isDeletion(ref));
  if (pushed.length === 0) {
    console.log("[prepush] skipped: nothing to check (only deletions)");
    return 0;
  }

  const stampDir = path.join(commonDir, "prepush-ok");
  const trees = pushed.flatMap((ref) => git(["rev-parse", `${ref.localSha}^{tree}`]) ?? []);
  if (trees.length === pushed.length && trees.every((tree) => existsSync(path.join(stampDir, tree)))) {
    console.log("[prepush] skipped: these trees already passed");
    return 0;
  }

  let changes: Changes;
  try {
    changes = collectChanges(pushed, git);
  } catch (error) {
    console.error(`[prepush] ${error instanceof Error ? error.message : error}\n${BYPASS_HINT}`);
    return 1;
  }
  if (changes.files.length === 0 || isDocsOrLockfileOnly(changes.files)) {
    console.log("[prepush] skipped: only docs or lockfiles changed");
    return 0;
  }

  const head = git(["rev-parse", "HEAD"]);
  const headTree = git(["rev-parse", "HEAD^{tree}"]);
  const clean = git(["status", "--porcelain", "--untracked-files=no"]) === "";
  if (!pushed.some((ref) => ref.localSha === head)) {
    console.warn("[prepush] warning: HEAD is not among the pushed commits; checks read the working tree");
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), "prepush-"));
  const testReportPath = path.join(reportDir, "vitest.json");
  const steps = buildSteps({
    files: changes.files,
    base: changes.commonBase,
    root,
    testReportPath,
    concurrency: parseConcurrency(process.env.PREPUSH_CONCURRENCY),
  });
  console.log(`[prepush] ${changes.files.length} changed file(s) against ${changes.commonBase.slice(0, 9)}`);

  const releaseLock = acquireLock(path.join(commonDir, "prepush.lock"), {
    isAlive,
    sleep: sleepSync,
    onWait: (holder) => console.log(`[prepush] waiting for another push's checks (pid ${holder}) to finish`),
  });
  const abort = (signal: NodeJS.Signals): void => {
    killActiveGroups();
    releaseLock();
    console.error(`\n[prepush] interrupted by ${signal}`);
    process.exit(1);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, abort);

  const startedAt = performance.now();
  try {
    for (const step of steps) {
      if (!(await runStep(step, root))) {
        console.error(`\n[prepush] failed at step "${step.name}". ${BYPASS_HINT}`);
        return 1;
      }
      if (step.name === "related-tests" && existsSync(testReportPath)) {
        if (countTestFiles(readFileSync(testReportPath, "utf8")) === 0) {
          console.log("[prepush] related-tests: no related test files for the changed sources");
        }
      }
    }
  } finally {
    killActiveGroups();
    releaseLock();
    rmSync(reportDir, { recursive: true, force: true });
  }

  // Checks read the working tree, so only a clean HEAD's tree is proven; other pushed trees stay unstamped.
  if (clean && headTree && trees.includes(headTree)) {
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(path.join(stampDir, headTree), "");
  }
  console.log(`\n[prepush] all checks passed in ${formatSeconds(startedAt)}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
