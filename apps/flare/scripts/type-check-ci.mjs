import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

parseArgs({ options: { force: { type: "boolean" } } });
const app = new URL("../", import.meta.url);
const result = spawnSync(process.execPath, ["run", "type-check"], {
  cwd: fileURLToPath(app),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
