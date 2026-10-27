import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

parseArgs({ options: { force: { type: "boolean" } } });
const root = new URL("../../../", import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL(".yarn/releases/yarn-4.12.0.cjs", root)),
    "workspace",
    "@calflare/web",
    "type-check",
  ],
  { cwd: fileURLToPath(root), stdio: "inherit" }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
