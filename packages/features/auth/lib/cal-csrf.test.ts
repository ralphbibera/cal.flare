import { createHash } from "node:crypto";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCalCsrfState } from "./cal-csrf";
import { getServerCsrfToken } from "./getServerCsrfToken";
import { withAuthRequestEnvironment } from "./request-context";

const secret = "synthetic-csrf-secret-only";
const token = "a".repeat(64);
const hash = (value: string, key: string) =>
  createHash("sha256")
    .update(value + key)
    .digest("hex");
const cookie = `${token}|${hash(token, secret)}`;
const name = `${WEBAPP_URL.startsWith("https://") ? "__Secure-" : ""}calcom.auth_csrf_token`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cal CSRF source cookie protocol", () => {
  it("accepts the original token-plus-secret SHA256 cookie and requires its submitted token", async () => {
    expect(await createCalCsrfState({ cookie, secret, submitted: token })).toEqual({
      kind: "existing",
      token,
      verified: true,
    });
    expect(await createCalCsrfState({ cookie, secret, submitted: "incorrect" })).toEqual({
      kind: "existing",
      token,
      verified: false,
    });
  });

  it("replaces missing, malformed, tampered or differently signed cookies without accepting submission", async () => {
    for (const invalid of [
      undefined,
      "malformed",
      `${cookie}tampered`,
      `${token}|${hash(token, "different-secret")}`,
    ]) {
      const state = await createCalCsrfState({ cookie: invalid, secret, submitted: token });
      expect(state.kind).toBe("created");
      expect(state.verified).toBe(false);
      expect(state.token).toMatch(/^[a-f0-9]{64}$/);
      if (state.kind === "created") expect(state.cookie).toBe(`${state.token}|${hash(state.token, secret)}`);
    }
  });

  it("reads SSR token locally without fetch or mutating the framework cookie object", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const callsBefore = fetch.mock.calls.length;
    const cookies = Object.freeze({ [name]: cookie });
    const request = Object.freeze({ cookies });
    expect(
      await withAuthRequestEnvironment({ NEXTAUTH_SECRET: secret }, () => getServerCsrfToken(request))
    ).toBe(token);
    expect(fetch.mock.calls).toHaveLength(callsBefore);
    expect(request.cookies).toEqual({ [name]: cookie });
  });

  it("isolates overlapping SSR signing secrets and rejects missing request configuration", async () => {
    const results = await Promise.all(
      ["first", "second"].map((key) =>
        withAuthRequestEnvironment({ NEXTAUTH_SECRET: key }, async () => {
          await Promise.resolve();
          const value = key.repeat(16);
          return getServerCsrfToken({ cookies: { [name]: `${value}|${hash(value, key)}` } });
        })
      )
    );
    expect(results).toEqual(["first".repeat(16), "second".repeat(16)]);
    await expect(getServerCsrfToken({ cookies: {} })).rejects.toThrow("Auth request binding is required");
    await expect(
      withAuthRequestEnvironment({ NEXTAUTH_SECRET: "" }, () => getServerCsrfToken({ cookies: {} }))
    ).rejects.toThrow("NEXTAUTH_SECRET is required for auth");
  });
});
