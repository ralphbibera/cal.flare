import { randomBytes } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const file = new URL("../.dev.vars", import.meta.url);
const names = [
  "PUBLIC_ORIGIN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_OWNER_EMAIL",
  "GOOGLE_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
];

async function main() {
  const { values } = parseArgs({
    options: { local: { type: "boolean" }, check: { type: "boolean" } },
  });
  if (values.local && values.check) {
    throw new Error("Choose either --local or --check.");
  }
  if (values.check) {
    let config;
    try {
      config = parseEnv(await readFile(file, "utf8"));
    } catch {
      throw new Error("Cannot read .dev.vars. Run bun run setup or repair the file in an editor.");
    }
    const missing = names.filter((name) => !config[name]?.trim());
    if (missing.length) {
      throw new Error(`Missing or empty variables: ${missing.join(", ")}. Edit .dev.vars privately.`);
    }
    console.log("All required local variable names have nonempty values. Google access is not verified.");
    return;
  }

  try {
    await lstat(file);
    throw new Error(
      ".dev.vars already exists. Edit it privately, then run bun run setup --check. Nothing was overwritten."
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const config = {
    PUBLIC_ORIGIN: "http://localhost:4321",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_OWNER_EMAIL: "",
    GOOGLE_CLIENT_SECRET: "",
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  if (!values.local) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Interactive setup needs a terminal. Use --local to create an incomplete local configuration."
      );
    }
    console.log("Create a Google OAuth web client first. See apps/flare/SETUP.md.");
    console.log("Do not paste secrets here. Enter GOOGLE_CLIENT_SECRET later in a private editor.");
    const prompts = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const origin = (await prompts.question("PUBLIC_ORIGIN [http://localhost:4321]: ")).trim();
      if (origin) config.PUBLIC_ORIGIN = origin;
      let parsed;
      try {
        parsed = new URL(config.PUBLIC_ORIGIN);
      } catch {
        throw new Error("PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin.");
      }
      if (
        parsed.origin !== config.PUBLIC_ORIGIN ||
        parsed.username ||
        parsed.password ||
        !(
          parsed.protocol === "https:" ||
          (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
        )
      ) {
        throw new Error(
          "Use an HTTPS origin, or HTTP on localhost, without a path, credentials, or trailing slash."
        );
      }
      config.GOOGLE_CLIENT_ID = (await prompts.question("GOOGLE_CLIENT_ID (blank to finish later): ")).trim();
      config.GOOGLE_OWNER_EMAIL = (
        await prompts.question("GOOGLE_OWNER_EMAIL (blank to finish later): ")
      ).trim();
      if ([config.GOOGLE_CLIENT_ID, config.GOOGLE_OWNER_EMAIL].some((value) => /[\r\n\0]/.test(value))) {
        throw new Error("Enter each value on a single line.");
      }
      if (config.GOOGLE_OWNER_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.GOOGLE_OWNER_EMAIL)) {
        throw new Error("GOOGLE_OWNER_EMAIL must be an email address.");
      }
    } finally {
      prompts.close();
    }
  }

  const content = names.map((name) => `${name}=${JSON.stringify(config[name])}`).join("\n");
  try {
    await writeFile(file, `${content}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(".dev.vars already exists. Nothing was overwritten. Edit it privately.");
    }
    throw new Error("Could not create .dev.vars. Check directory permissions.");
  }
  console.log(`Created ${fileURLToPath(file)} with owner-only permissions.`);
  console.log(
    "Google setup is pending. Open that file in a private editor and fill the blank Google fields."
  );
  console.log(
    "Then run bun run setup --check. No Google login, remote resource creation, or deployment was performed."
  );
}

main().catch((error) => {
  let message = "Setup failed. Check the command flags and local file permissions.";
  if (error instanceof Error && error.code === undefined) message = error.message;
  console.error(message);
  process.exitCode = 1;
});
