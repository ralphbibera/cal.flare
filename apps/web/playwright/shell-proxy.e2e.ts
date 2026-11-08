import { expect } from "@playwright/test";
import { test } from "./lib/fixtures";

// Expected values come from the pinned shell sources: apps/web/proxy.ts (matcher, sanitizer,
// cookie and CSP branches), apps/web/next.config.ts (redirects, rewrites, headers),
// app/(use-page-wrapper)/maintenance/page.tsx and event-types/[type]/error.tsx.
test.afterEach(async ({ users }) => {
  await users.deleteAll();
});

test("deletes the Better Auth session cookie on logout", async ({ request }) => {
  const response = await request.get("/auth/logout", {
    headers: { cookie: "better-auth.session_token=shell-acceptance-token" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  const setCookies = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value);
  const sessionCookie = setCookies.find((value) => value.startsWith("better-auth.session_token="));
  expect(sessionCookie).toContain("Path=/");
  expect(sessionCookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT|Max-Age=0/);
  expect(setCookies.some((value) => value.startsWith("__Secure-better-auth.session_token="))).toBe(true);
  expect(await response.text()).toContain("You&#x27;ve been logged out");
});

test("returns the signup-disabled response from the D1 runtime flag", async ({ request, prisma }) => {
  await prisma.$executeRawUnsafe(
    'UPDATE "RuntimeConfig" SET "valueJson" = ? WHERE "key" = ?',
    "true",
    "isSignupDisabled"
  );
  try {
    const disabled = await request.post("/api/auth/signup", { data: {} });
    expect(disabled.status()).toBe(503);
    expect(await disabled.json()).toEqual({ error: "Signup is disabled" });
    // The source returns before responseWithHeaders, so this response has no CSP status header.
    expect(disabled.headers()["x-csp-status"]).toBeUndefined();
  } finally {
    await prisma.$executeRawUnsafe(
      'UPDATE "RuntimeConfig" SET "valueJson" = ? WHERE "key" = ?',
      "false",
      "isSignupDisabled"
    );
  }

  const enabled = await request.post("/api/auth/signup");
  expect(enabled.status()).toBe(400);
  expect(enabled.headers()["x-csp-status"]).toBe("not-opted-in");
});

test("preserves configured redirects, rewrites and trailing-slash canonicalization", async ({ request }) => {
  for (const { path, status, location } of [
    { path: "/auth", status: 307, location: "/auth/login" },
    { path: "/settings", status: 308, location: "/settings/my-account/profile" },
    { path: "/bookings", status: 308, location: "/bookings/upcoming" },
    { path: "/more/", status: 308, location: "/more" },
    { path: "/api/app-store/salesroom", status: 308, location: "/app-store/salesroom" },
  ]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(status);
    expect(response.headers().location, path).toBe(location);
  }

  const login = await request.get("/login");
  expect(login.status()).toBe(200);
  expect(await login.text()).toContain('data-testid="login-form"');
});

test("keeps config redirects ahead of the proxy return-to cookie branch", async ({ request }) => {
  // next.config.ts permanently redirects /apps/installed, so the proxy branch is never reached
  // for this path. The source branch stays in proxy.test.ts; this asserts the observed rule order.
  const response = await request.get("/apps/installed", {
    headers: { cookie: "return-to=/event-types" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("/apps/installed/calendar");
  expect(response.headersArray().some((header) => header.name.toLowerCase() === "set-cookie")).toBe(false);
});

test("sanitizes non-ASCII request headers before the page renders", async ({ request }) => {
  // APIRequestContext sends each spelling as UTF-8 bytes. "São Paulo" reaches the mojibake
  // strip branch, while "SÃ£o Paulo" reaches the NFKD branch; both must be ASCII on the page.
  const decomposed = await request.get("/auth/login", { headers: { "cf-ipcountry": "São Paulo" } });
  expect(decomposed.status()).toBe(200);
  const decomposedHtml = await decomposed.text();
  expect(decomposedHtml).toContain("So Paulo");
  expect(decomposedHtml).not.toContain("São Paulo");

  const mojibake = await request.get("/auth/login", { headers: { "cf-ipcountry": "SÃ£o Paulo" } });
  expect(mojibake.status()).toBe(200);
  const mojibakeHtml = await mojibake.text();
  expect(mojibakeHtml).toContain("Sao Paulo");
  expect(mojibakeHtml).not.toContain("SÃ£o Paulo");
});

test("serves the no-policy CSP branch and the configured frame headers", async ({ request }) => {
  const login = await request.get("/auth/login");
  expect(login.status()).toBe(200);
  expect(login.headers()["x-csp-status"]).toBe("not-opted-in");
  expect(login.headers()["content-security-policy"]).toBeUndefined();
  expect(login.headers()["x-frame-options"]).toBe("DENY");
  expect(login.headers()["x-content-type-options"]).toBe("nosniff");
  expect(login.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(await login.text()).toContain('<head nonce="">');

  const signup = await request.get("/signup");
  expect(signup.status()).toBe(200);
  expect(signup.headers()["x-frame-options"]).toBe("DENY");
});

test("applies embed headers only to the encoded embed request", async ({ request, users }) => {
  const user = await users.create();

  const enabled = await request.get(`/${user.username}/embed?flag.coep=true&ui.color-scheme=dark`);
  expect(enabled.status()).toBe(200);
  expect(enabled.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(enabled.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(enabled.headers()["x-embedcolorscheme"]).toBe("dark");
  expect(enabled.headers()["x-isembed"]).toBe("true");
  expect(enabled.headers()["x-csp-status"]).toBe("not-opted-in");

  const plain = await request.get(`/${user.username}/embed`);
  expect(plain.status()).toBe(200);
  expect(plain.headers()["cross-origin-embedder-policy"]).toBeUndefined();
  expect(plain.headers()["x-embedcolorscheme"]).toBeUndefined();
  expect(plain.headers()["x-isembed"]).toBe("true");
  expect(plain.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
});

test("serves the maintenance page", async ({ request }) => {
  const response = await request.get("/maintenance");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("Down for maintenance");
  expect(html).toContain("The Cal.flare team are performing scheduled maintenance.");
  expect(html).toContain('href="http://localhost:3000/support"');
});

test("renders the event-type error boundary for a thrown render error", async ({ page, users }) => {
  const user = await users.create();
  await user.apiLogin();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/event-types/not-a-number");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Something went wrong." })).toBeVisible();
  expect(errors).toEqual([]);
});
