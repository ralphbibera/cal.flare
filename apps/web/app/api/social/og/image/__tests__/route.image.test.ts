import { readFile } from "node:fs/promises";

import { NextRequest } from "next/server";
import { describe, expect, test, vi } from "vitest";

import { GET } from "../route";

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  WEBAPP_URL: "https://calflare.test",
}));

const publicDir = new URL("../../../../../../public/", import.meta.url);

const staticFiles: Record<string, { path: string; contentType: string }> = {
  "/fonts/cal.ttf": { path: "fonts/cal.ttf", contentType: "font/ttf" },
  "/fonts/Inter-Regular.ttf": { path: "fonts/Inter-Regular.ttf", contentType: "font/ttf" },
  "/fonts/Inter-Medium.ttf": { path: "fonts/Inter-Medium.ttf", contentType: "font/ttf" },
  "/social-bg-light-lines.jpg": { path: "social-bg-light-lines.jpg", contentType: "image/jpeg" },
  "/social-bg-dark-lines.jpg": { path: "social-bg-dark-lines.jpg", contentType: "image/jpeg" },
  "/calcom-logo-white-word.svg": { path: "calcom-logo-white-word.svg", contentType: "image/svg+xml" },
  "/cal-logo-word-black.svg": { path: "cal-logo-word-black.svg", contentType: "image/svg+xml" },
  "/app-store/zoomvideo/icon.svg": {
    path: "app-store/zoomvideo/icon.svg",
    contentType: "image/svg+xml",
  },
};

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  let href: string;
  if (input instanceof Request) href = input.url;
  else if (input instanceof URL) href = input.href;
  else href = input;

  const file = staticFiles[new URL(href).pathname.replace(/\/{2,}/g, "/")];
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await readFile(new URL(file.path, publicDir))), {
    headers: { "content-type": file.contentType },
  });
});

function createRequest(query: string) {
  const request = new Request(`http://example.com/api/social/og/image?${query}`, { method: "GET" });
  return new NextRequest(request);
}

describe("GET /api/social/og/image renders a PNG", () => {
  test.each([
    ["generic", "type=generic&title=Test&description=Hello"],
    ["meeting", "type=meeting&title=Team%20sync&meetingProfileName=Alice"],
    ["app", "type=app&name=Zoom&description=Video&slug=zoomvideo&logoUrl=/app-store/zoomvideo/icon.svg"],
  ])("%s returns a 1200x630 PNG with a stable ETag", async (_, query) => {
    const response = await GET(createRequest(query));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{8}"$/);
    expect(response.headers.get("cache-control")).toContain("immutable");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);

    const second = await GET(createRequest(query));
    expect(second.headers.get("etag")).toBe(response.headers.get("etag"));
  });
});

describe("social background images", () => {
  test.each(["light", "dark"])("ships social-bg-%s-lines.jpg", async (variant) => {
    const bytes = await readFile(new URL(`social-bg-${variant}-lines.jpg`, publicDir));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
  });
});
