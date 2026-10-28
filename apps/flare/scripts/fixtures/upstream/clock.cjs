const { createRequire } = require("node:module");
const { join } = require("node:path");
const load = createRequire(join(process.env.CALFLARE_REFERENCE_ROOT, "package.json"));
if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "UTC") {
  throw new Error("Reference server timezone must be UTC");
}
const timeout = global.setTimeout;
const performance = global.performance;
load("@sinonjs/fake-timers").install({
  now: new Date("2030-01-09T12:00:00Z"),
  toFake: ["Date"],
});
if (global.setTimeout !== timeout || global.performance !== performance) {
  throw new Error("Reference clock changed native timers");
}
