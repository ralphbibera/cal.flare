import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GET } from "../route";

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
    path: "../../../packages/app-store/zoomvideo/static/icon.svg",
    contentType: "image/svg+xml",
  },
};

async function publicAsset(pathname: string) {
  const file = staticFiles[pathname.replace(/\/{2,}/g, "/")];
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await readFile(new URL(file.path, publicDir))), {
    headers: { "content-type": file.contentType },
  });
}

const assets = vi.hoisted(() => ({ requests: [] as string[], fetch: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: { ASSETS: { fetch: assets.fetch } } }));
vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  WEBAPP_URL: "https://calflare.test",
}));

function createRequest(query: string) {
  return new NextRequest(new Request(`http://example.com/api/social/og/image?${query}`, { method: "GET" }));
}

function requestedUrl(input: RequestInfo | URL) {
  try {
    return input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
  } catch {
    return undefined;
  }
}

function requestedPath(input: RequestInfo | URL) {
  return (requestedUrl(input)?.pathname ?? String(input)).replace(/\/{2,}/g, "/");
}

async function pngDetails(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    signature: Array.from(bytes.slice(0, 8)),
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const images = [
  [
    "generic",
    "type=generic&title=Test&description=Hello",
    ["/social-bg-light-lines.jpg", "/cal-logo-word-black.svg"],
  ],
  [
    "meeting",
    "type=meeting&title=Team%20sync&meetingProfileName=Alice",
    ["/social-bg-dark-lines.jpg", "/calcom-logo-white-word.svg"],
  ],
  [
    "app",
    "type=app&name=Zoom&description=Video&slug=zoomvideo&logoUrl=/app-store/zoomvideo/icon.svg",
    ["/social-bg-light-lines.jpg", "/calcom-logo-white-word.svg", "/app-store/zoomvideo/icon.svg"],
  ],
] as const;

beforeEach(() => {
  assets.requests.length = 0;
  assets.fetch.mockReset();
  assets.fetch.mockImplementation(async (request: Request) => {
    const pathname = new URL(request.url).pathname;
    assets.requests.push(pathname);
    return publicAsset(pathname);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/social/og/image with Worker static assets", () => {
  test.each(images)("%s reads fonts, backgrounds and logos without a self-fetch", async (_, query, paths) => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      throw new Error("unexpected self-fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(createRequest(query));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{8}"$/);
    expect(response.headers.get("cache-control")).toContain("immutable");

    const png = await pngDetails(response);
    expect(png.signature).toEqual(pngSignature);
    expect(png.width).toBe(1200);
    expect(png.height).toBe(630);

    expect(
      fetchMock.mock.calls.filter(([input]) => requestedUrl(input)?.hostname === "calflare.test")
    ).toEqual([]);
    expect(assets.requests).toEqual(
      expect.arrayContaining([
        "/fonts/cal.ttf",
        "/fonts/Inter-Regular.ttf",
        "/fonts/Inter-Medium.ttf",
        ...paths,
      ])
    );

    const second = await GET(createRequest(query));
    expect(second.headers.get("etag")).toBe(response.headers.get("etag"));
  });
});

describe("GET /api/social/og/image without the ASSETS binding", () => {
  test.each(images)("%s reads assets over fetch", async (_, query, paths) => {
    vi.stubGlobal("navigator", { userAgent: "Node.js" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => publicAsset(requestedPath(input)));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(createRequest(query));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const png = await pngDetails(response);
    expect(png.signature).toEqual(pngSignature);
    expect(png.width).toBe(1200);
    expect(png.height).toBe(630);

    expect(assets.fetch).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([input]) => requestedPath(input))).toEqual(
      expect.arrayContaining([
        "/fonts/cal.ttf",
        "/fonts/Inter-Regular.ttf",
        "/fonts/Inter-Medium.ttf",
        ...paths,
      ])
    );
  });
});
