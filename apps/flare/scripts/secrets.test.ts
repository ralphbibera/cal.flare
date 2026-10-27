import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { encryptionKey, seal, unseal } from "../src/server/secrets.ts";

test("credential keys require canonical base64 for exactly 32 bytes", async () => {
  const valid = btoa("k".repeat(32));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const alias = `${valid.slice(0, -2)}${alphabet[alphabet.indexOf(valid.at(-2) ?? "") + 1]}=`;
  assert.equal(atob(alias), atob(valid));
  for (const value of [
    "",
    "invalid",
    valid.slice(0, -1),
    `${valid}\n`,
    alias,
    btoa("k".repeat(31)),
    btoa("k".repeat(33)),
  ]) {
    await assert.rejects(encryptionKey(value), { code: "CONFIGURATION" });
  }
  assert.ok(await encryptionKey(valid));
});

test("credential envelopes authenticate their context, version, key and contents", async () => {
  const key = await encryptionKey(btoa("k".repeat(32)));
  const otherKey = await encryptionKey(btoa("x".repeat(32)));
  const value = JSON.stringify({ refresh: "fixture-refresh", note: "Kumusta 🌏" });
  const context = "google:owner";
  const first = await seal(key, value, context);
  const second = await seal(key, value, context);
  assert.notEqual(first, second);
  assert.match(first, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!first.includes("fixture-refresh"));
  assert.equal(await unseal(key, first, context), value);
  assert.equal(await unseal(key, second, context), value);
  await assert.rejects(unseal(key, first, "oauth-pkce"), { code: "TOKEN_STORAGE" });
  await assert.rejects(unseal(otherKey, first, context), { code: "TOKEN_STORAGE" });
  const parts = first.split(".");
  const changed = `${parts[0]}.${parts[1]}.${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  for (const envelope of [first.replace(/^v1/, "v2"), `${first}.extra`, "v1.AA.AA", changed]) {
    await assert.rejects(unseal(key, envelope, context), { code: "TOKEN_STORAGE" });
  }
});

test("identity storage rejects null keys, orphan records and a second milestone owner", async () => {
  const migration = await readFile(new URL("../migrations/0001_identity.sql", import.meta.url), "utf8");
  const platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    persist: false,
    remoteBindings: false,
  });
  try {
    const db = platform.env.DB;
    await db.batch(
      migration
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => db.prepare(sql))
    );
    await assert.rejects(db.prepare("INSERT INTO google_connection VALUES ('owner', 'ciphertext', 1)").run());
    await assert.rejects(db.prepare("INSERT INTO owner_session VALUES ('hash', 'owner', 1)").run());
    await db.prepare("INSERT INTO owner VALUES ('owner', 'subject', 'owner@example.test', 'Owner')").run();
    for (const sql of [
      "INSERT INTO owner VALUES (NULL, 'null-subject', 'null@example.test', 'Null')",
      "INSERT INTO google_connection VALUES (NULL, 'ciphertext', 1)",
      "INSERT INTO owner_session VALUES (NULL, 'owner', 1)",
      "INSERT INTO oauth_attempt VALUES (NULL, 'binding-hash', 'verifier-ciphertext', 1)",
    ]) {
      await assert.rejects(db.prepare(sql).run(), /NOT NULL/, sql);
    }
    await db.prepare("INSERT INTO google_connection VALUES ('owner', 'ciphertext', 1)").run();
    await db.prepare("INSERT INTO owner_session VALUES ('hash', 'owner', 1)").run();
    await assert.rejects(
      db.prepare("INSERT INTO owner VALUES ('other', 'other-subject', 'other@example.test', 'Other')").run()
    );
    await assert.rejects(db.prepare("DELETE FROM owner WHERE id = 'owner'").run());
    assert.equal(await db.prepare("SELECT count(*) FROM google_connection").first("count(*)"), 1);
    assert.equal(await db.prepare("SELECT count(*) FROM owner_session").first("count(*)"), 1);
  } finally {
    await platform.dispose();
  }
});
