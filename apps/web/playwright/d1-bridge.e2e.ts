import { expect } from "@playwright/test";
import { test } from "./lib/fixtures";

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ users }) => {
  await users.deleteAll();
});

test("fixtures and the preview Worker read and write the same D1 database", async ({
  page,
  users,
  prisma,
}) => {
  // Written by the Playwright process through the fixture D1 binding.
  const user = await users.create({ username: "d1-bridge" });
  const before = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { password: { select: { hash: true } } },
  });

  // Also written by the fixture process. The Worker can only act on it if it reads the same D1.
  const request = await prisma.resetPasswordRequest.create({
    data: { email: user.email, expires: new Date(Date.now() + 60_000) },
  });

  const csrfResponse = await page.request.get("/api/csrf");
  expect(csrfResponse.ok()).toBe(true);
  const { csrfToken } = await csrfResponse.json();

  const response = await page.request.post("/api/auth/reset-password", {
    data: { csrfToken, password: "D1BridgePass1", requestId: request.id },
  });
  expect(response.status()).toBe(201);

  // The Worker wrote back into the same D1: the fixture-created user's password changed and the
  // fixture-created reset request was expired.
  const [after, expired] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { password: { select: { hash: true } } },
    }),
    prisma.resetPasswordRequest.findUniqueOrThrow({ where: { id: request.id } }),
  ]);
  expect(after.password?.hash).not.toBe(before.password?.hash);
  expect(expired.expires.getTime()).toBeLessThanOrEqual(Date.now());
});
