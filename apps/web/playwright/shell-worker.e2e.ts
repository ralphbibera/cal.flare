import { expect } from "@playwright/test";
import { test } from "./lib/fixtures";

// Expected values come from the pinned Cal.diy shell sources: app/layout.tsx metadata,
// app/_utils.tsx title/canonical/OG construction, modules/shell/navigation item ids,
// app/(use-page-wrapper)/refer/loading.tsx, and app/api/csrf/route.ts.
test.afterEach(async ({ users }) => {
  await users.deleteAll();
});

test("serves the shared shell and page metadata on a hard load", async ({ page, users }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("NEXT_PUBLIC_WEBAPP_URL is required");
  const user = await users.create();
  await user.apiLogin();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // The raw response proves the shell is in the server HTML, not only in the hydrated client.
  const response = await page.request.get("/more");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("<title>More | Cal.flare</title>");
  expect(html).toContain('data-testid="dashboard-shell"');
  expect(html).toContain('data-testid="event_types_page_title-test"');
  expect(html).toContain('href="/event-types"');
  expect(html).toContain('href="/bookings/upcoming"');
  expect(html).toContain('href="/availability"');
  expect(html).toContain('href="/apps"');
  expect(html).toMatch(/<html[^>]*lang="en"[^>]*dir="ltr"/);
  expect(html).toContain(`<link rel="canonical" href="${baseURL}/more">`);
  expect(html).toContain('<meta property="og:title" content="More | Cal.flare">');
  expect(html).toContain(`<meta property="og:url" content="${baseURL}/more">`);
  expect(html).toContain('<meta property="og:site_name" content="Cal.flare">');
  expect(html).toContain('<meta property="og:type" content="website">');

  await page.goto("/more");
  await expect(page).toHaveTitle("More | Cal.flare");
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  await expect(page.getByTestId("event_types_page_title-test")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  expect(errors).toEqual([]);
});

test("keeps client navigation and browser history inside the shell", async ({ page, users }) => {
  const user = await users.create();
  await user.apiLogin();
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });

  await page.goto("/more");
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  documents.length = 0;

  await page.getByTestId("event_types_page_title-test").click();
  await expect(page).toHaveURL(/\/event-types$/);
  await expect(page).toHaveTitle("Event types | Cal.flare");
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  expect(documents).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL(/\/more$/);
  await expect(page).toHaveTitle("More | Cal.flare");
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  expect(documents).toEqual([]);

  await page.goForward();
  await expect(page).toHaveURL(/\/event-types$/);
  await expect(page).toHaveTitle("Event types | Cal.flare");
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  expect(documents).toEqual([]);
});

test("submits the sign-in form through the Worker without a document reload", async ({ page }) => {
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });

  await page.goto("/auth/login");
  await expect(page.getByTestId("login-form")).toBeVisible();
  documents.length = 0;

  await page.locator("#email").fill("shell-acceptance@example.com");
  await page.locator("#password").fill("WrongPassword1!");
  await page.getByTestId("login-form").getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("alert")).toContainText("Email or password is incorrect.");
  await expect(page).toHaveURL(/\/auth\/login$/);
  expect(documents).toEqual([]);
});

test("streams the original loading boundary before the referrals page resolves", async ({ request }) => {
  const response = await request.get("/refer");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  const html = await response.text();

  const loadingIndex = html.indexOf('class="animate-pulse mx-auto max-w-4xl"');
  const pageIndex = html.indexOf("You need a Dub API Key and Program Id to use this page.");
  expect(loadingIndex).toBeGreaterThanOrEqual(0);
  expect(pageIndex).toBeGreaterThan(loadingIndex);
  expect(html).toContain("h-7 w-3/4");
  expect(html).toContain("h-7 w-1/2");
  expect(html).toContain("Referral program");
});

test("uses the session locale for SSR language and direction", async ({ page, users }) => {
  const user = await users.create({ locale: "ar" });
  await user.apiLogin();

  const response = await page.goto("/more");
  expect(response?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  await expect(page.getByTestId("event_types_page_title-test")).toHaveText("أنواع الحدث");
});

test("serves the CSRF token with the original cookie attributes", async ({ request }) => {
  const response = await request.get("/api/csrf?sameSite=strict");
  expect(response.status()).toBe(200);
  const { csrfToken } = await response.json();
  expect(csrfToken).toMatch(/^[a-f0-9]{64}$/);
  const strictCookie = response.headersArray().find((header) => header.name.toLowerCase() === "set-cookie");
  expect(strictCookie?.value).toBe(`calcom.csrf_token=${csrfToken}; Path=/; HttpOnly; SameSite=strict`);

  const insecureNone = await request.get("/api/csrf?sameSite=none");
  expect(insecureNone.status()).toBe(200);
  const laxCookie = insecureNone.headersArray().find((header) => header.name.toLowerCase() === "set-cookie");
  expect(laxCookie?.value).toMatch(/^calcom\.csrf_token=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=lax$/);
});

test("serves the manifest and favicon referenced by the root metadata", async ({ request }) => {
  const manifest = await request.get("/site.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toBe("application/manifest+json");
  expect(await manifest.json()).toMatchObject({
    name: "Cal.flare",
    short_name: "Cal.flare",
    start_url: "/",
    scope: "/",
    display: "standalone",
    icons: [
      { src: "/api/logo?type=android-chrome-192", sizes: "192x192", type: "image/png" },
      { src: "/api/logo?type=android-chrome-256", sizes: "256x256", type: "image/png" },
    ],
  });

  const favicon = await request.get("/api/logo?type=favicon-32");
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()["content-type"]).toBe("image/png");
  expect((await favicon.body()).subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );

  const ico = await request.get("/favicon.ico");
  expect(ico.status()).toBe(200);
  expect(ico.headers()["content-type"]).toBe("image/x-icon");
});
