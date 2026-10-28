const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const { isAbsolute, join } = require("node:path");

const root = process.env.CALFLARE_REFERENCE_ROOT;
assert.ok(root && isAbsolute(root), "Set CALFLARE_REFERENCE_ROOT to the clean pinned checkout");
const command = process.argv[2] ?? "start";
assert.ok(["build", "start"].includes(command), "Use build or start for the reference fixture");
const pin = "0f19cc46ef6b6426ee398c670575b3c96be7af9e";
assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), pin);
execFileSync("git", ["-C", root, "diff", "--quiet", pin]);
const dir = join(root, "apps/web");
for (const base of [root, dir]) {
  for (const file of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
  ]) {
    assert.ok(!existsSync(join(base, file)), "Reference checkout must not contain private configuration");
  }
}
const retained = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, retained, {
  CALFLARE_REFERENCE_ROOT: root,
  NODE_ENV: "production",
  TZ: "UTC",
  NODE_OPTIONS: `--max-old-space-size=4096 --require=${JSON.stringify(join(__dirname, "clock.cjs"))}`,
  NEXTAUTH_SECRET: randomBytes(32).toString("hex"),
  CALENDSO_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  NEXTAUTH_URL: "http://127.0.0.1:18800/api/auth",
  NEXT_PUBLIC_WEBAPP_URL: "http://127.0.0.1:18800",
  NEXT_PUBLIC_WEBSITE_URL: "http://127.0.0.1:18800",
  DATABASE_URL: "postgresql://calflare_reference@127.0.0.1:18796/calflare_reference",
  DATABASE_DIRECT_URL: "postgresql://calflare_reference@127.0.0.1:18796/calflare_reference",
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  HUSKY: "0",
});
require("./clock.cjs");
process.chdir(dir);
const load = createRequire(join(root, "package.json"));
const cli = load.resolve("next/dist/bin/next");
const routes = [
  "app/(booking-page-wrapper)/*/page.tsx",
  "app/(booking-page-wrapper)/*/*/page.tsx",
  "app/api/logo/route.ts",
  "app/api/avatar/*/route.ts",
  "pages/api/auth/*",
  "pages/api/trpc/{features,slots,timezones,public}/*",
].join(",");
process.argv = [
  process.execPath,
  cli,
  command,
  ...(command === "build"
    ? ["--experimental-build-mode", "compile", "--debug-build-paths", routes]
    : ["--hostname", "127.0.0.1", "--port", "18800"]),
];
load(cli);
