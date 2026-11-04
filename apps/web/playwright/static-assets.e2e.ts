import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const pathname = "/app-store/salesroom/salesroom-demo.mp4";
const original = readFileSync(
  path.resolve(__dirname, "../../../packages/app-store/salesroom/static/salesroom-demo.mp4")
);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("serves original oversized media bytes and HEAD metadata", async ({ request }) => {
  const response = await request.get(pathname);
  expect(response.status()).toBe(200);
  expect(hash(await response.body())).toBe(hash(original));
  expect(response.headers()["content-type"]).toBe("video/mp4");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response.headers()["content-length"]).toBe(String(original.length));
  expect(response.headers().etag).toMatch(/^W\/"/);
  const head = await request.head(pathname);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-length"]).toBe(String(original.length));
  expect(head.headers().etag).toBe(response.headers().etag);
  expect(await head.body()).toHaveLength(0);
});

test("serves byte ranges across generated parts and suffix ranges", async ({ request }) => {
  const start = 20 * 1024 * 1024 - 7;
  const end = start + 31;
  const response = await request.get(pathname, { headers: { Range: "bytes=" + start + "-" + end } });
  expect(response.status()).toBe(206);
  expect(response.headers()["content-range"]).toBe("bytes " + start + "-" + end + "/" + original.length);
  expect(await response.body()).toEqual(original.subarray(start, end + 1));
  const suffix = await request.get(pathname, { headers: { Range: "bytes=-32" } });
  expect(suffix.status()).toBe(206);
  expect(await suffix.body()).toEqual(original.subarray(-32));
  const open = await request.head(pathname, { headers: { Range: "bytes=" + start + "-" } });
  expect(open.status()).toBe(206);
  expect(open.headers()["content-length"]).toBe(String(original.length - start));
});

test("preserves conditional and range preconditions", async ({ request }) => {
  const head = await request.head(pathname);
  const etag = head.headers().etag;
  const modified = head.headers()["last-modified"];
  expect(
    (
      await request.get(pathname, { headers: { "If-None-Match": etag, "Cache-Control": "max-age=0" } })
    ).status()
  ).toBe(304);
  expect(
    (
      await request.head(pathname, {
        headers: { "If-Modified-Since": modified, "Cache-Control": "max-age=0" },
      })
    ).status()
  ).toBe(304);
  expect((await request.get(pathname, { headers: { "If-Match": '"missing"' } })).status()).toBe(412);
  expect(
    (
      await request.head(pathname, { headers: { "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" } })
    ).status()
  ).toBe(412);
  const unsatisfied = await request.get(pathname, { headers: { Range: "bytes=" + original.length + "-" } });
  expect(unsatisfied.status()).toBe(416);
  expect(unsatisfied.headers()["content-range"]).toBe("bytes */" + original.length);
  const partial = await request.get(pathname, { headers: { Range: "bytes=0-7", "If-Range": etag } });
  expect(partial.status()).toBe(206);
  expect(await partial.body()).toEqual(original.subarray(0, 8));
  expect(
    (await request.head(pathname, { headers: { Range: "bytes=0-7", "If-Range": '"stale"' } })).status()
  ).toBe(200);
  expect((await request.head(pathname, { headers: { Range: "bytes=0-1,10-11" } })).status()).toBe(200);
});

test("retains method enforcement and continues after cancellation", async ({ request }, testInfo) => {
  expect((await request.post(pathname)).status()).toBe(405);
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("NEXT_PUBLIC_WEBAPP_URL is required");
  const response = await fetch(new URL(pathname, baseURL));
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  await reader?.read();
  await reader?.cancel();
  expect((await request.head(pathname)).status()).toBe(200);
});
