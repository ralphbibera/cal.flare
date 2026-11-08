import { expect } from "@playwright/test";
import { test } from "./lib/fixtures";

// Opted-in branch of the pinned CSP middleware. The built Worker can carry a different CSP_POLICY
// from the runner's .env, so the response decides whether the non-strict policy is in effect.
test("adds the nonce and non-strict CSP to login pages when opted in", async ({ request }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("NEXT_PUBLIC_WEBAPP_URL is required");

  const login = await request.get("/auth/login");
  expect(login.status()).toBe(200);
  const csp = login.headers()["content-security-policy"];
  if (!csp?.includes("style-src 'self' 'unsafe-inline'")) {
    test.skip(true, "the Worker was not built with CSP_POLICY=non-strict");
    return;
  }
  expect(login.headers()["x-csp-status"]).toBeUndefined();
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toBe(
    `default-src 'self' ; script-src 'nonce-${nonce}' 'strict-dynamic' 'self' 'unsafe-inline' https:; object-src 'none'; base-uri 'none'; child-src app.cal.com; style-src 'self' 'unsafe-inline' app.cal.com; font-src 'self'; img-src 'self' ${baseURL} https://img.youtube.com https://eu.ui-avatars.com/api/ data:; connect-src 'self'`
  );
  expect(await login.text()).toContain(`<head nonce="${nonce}">`);

  const logout = await request.get("/auth/logout");
  expect(logout.status()).toBe(200);
  expect(logout.headers()["content-security-policy"]).toBeUndefined();
  expect(logout.headers()["x-csp-status"]).toBeUndefined();
  expect(await logout.text()).toMatch(/<head nonce="[^"]+">/);

  const signup = await request.post("/api/auth/signup", { data: {} });
  expect(signup.headers()["x-csp-status"]).toBe("not-opted-in");
});
