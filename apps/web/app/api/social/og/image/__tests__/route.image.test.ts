import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import type { ReactNode } from "react";
import { isValidElement } from "react";
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

async function assetBytes(pathname: string) {
  const file = staticFiles[pathname.replace(/\/{2,}/g, "/")];
  if (!file) return null;
  return { bytes: await readFile(new URL(file.path, publicDir)), contentType: file.contentType };
}

async function publicAsset(pathname: string) {
  const asset = await assetBytes(pathname);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(asset.bytes), { headers: { "content-type": asset.contentType } });
}

// ImageResponse is stubbed so the test reads the element tree the route hands to
// the renderer. Next's Node renderer cannot draw the shared components' string
// image dimensions; the Worker renderer is verified separately.
const rendered = vi.hoisted(() => ({ elements: [] as ReactNode[] }));
vi.mock("next/og", () => ({
  ImageResponse: vi.fn(function (this: unknown, element: ReactNode) {
    rendered.elements.push(element);
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
          controller.close();
        },
      }),
    };
  }),
}));

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

interface ElementFacts {
  sources: string[];
  backgroundImages: string[];
  dimensions: unknown[];
}

function collect(node: ReactNode, facts: ElementFacts) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, facts);
    return;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return;

  const props = node.props;
  if (node.type === "img") {
    if (typeof props.src === "string") facts.sources.push(props.src);
    facts.dimensions.push(props.width, props.height);
  }
  const style = props.style;
  if (style && typeof style === "object" && "backgroundImage" in style) {
    const backgroundImage = (style as { backgroundImage?: unknown }).backgroundImage;
    if (typeof backgroundImage === "string") facts.backgroundImages.push(backgroundImage);
  }
  collect(props.children as ReactNode, facts);
}

function elementFacts(index: number): ElementFacts {
  const facts: ElementFacts = { sources: [], backgroundImages: [], dimensions: [] };
  collect(rendered.elements[index], facts);
  return facts;
}

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

const fonts = ["/fonts/cal.ttf", "/fonts/Inter-Regular.ttf", "/fonts/Inter-Medium.ttf"];

beforeEach(() => {
  rendered.elements.length = 0;
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
  test.each(images)("%s inlines its own images and never self-fetches", async (_, query, paths) => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      throw new Error("unexpected self-fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(createRequest(query));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{8}"$/);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, s-maxage=31536000, stale-while-revalidate=31536000"
    );

    expect(assets.requests).toEqual(expect.arrayContaining([...fonts, ...paths]));
    expect(fetchMock).not.toHaveBeenCalled();

    const facts = elementFacts(0);
    const inlined = Array.from(
      new Set([
        ...facts.sources,
        ...facts.backgroundImages.flatMap((value) =>
          Array.from(value.matchAll(/url\(([^)]+)\)/g), (match) => match[1])
        ),
      ])
    );
    const inlinedAssets = await Promise.all(
      inlined.map(async (source) => {
        const match = /^data:([^;]+);base64,(.*)$/.exec(source);
        expect(match).not.toBeNull();
        return { contentType: match?.[1] ?? "", bytes: Buffer.from(match?.[2] ?? "", "base64") };
      })
    );
    const expectedAssets = await Promise.all(
      paths.map(async (pathname) => {
        const asset = await assetBytes(pathname);
        return { contentType: asset?.contentType, bytes: asset?.bytes };
      })
    );
    expect(inlinedAssets).toHaveLength(expectedAssets.length);
    for (const expected of expectedAssets) {
      expect(inlinedAssets).toContainEqual(expected);
    }

    expect(facts.dimensions.every((value) => value === undefined || typeof value === "string")).toBe(true);

    const second = await GET(createRequest(query));
    expect(second.headers.get("etag")).toBe(response.headers.get("etag"));
    expect(second.headers.get("cache-control")).toBe(response.headers.get("cache-control"));
  });
});

describe("GET /api/social/og/image without the ASSETS binding", () => {
  test.each(images)("%s keeps its own images as URLs and reads fonts over fetch", async (_, query, paths) => {
    vi.stubGlobal("navigator", { userAgent: "Node.js" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => publicAsset(requestedPath(input)));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(createRequest(query));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    expect(assets.fetch).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([input]) => requestedPath(input))).toEqual(
      expect.arrayContaining(fonts)
    );

    const facts = elementFacts(0);
    const sourcePaths = facts.sources.map((source) =>
      new URL(source).pathname.replace(/\/{2,}/g, "/")
    );
    expect(sourcePaths).toEqual(expect.arrayContaining([...paths]));
    expect(facts.sources.every((source) => !source.startsWith("data:"))).toBe(true);
    expect(facts.backgroundImages.every((value) => value.startsWith("url(https://calflare.test"))).toBe(
      true
    );
    expect(facts.dimensions.every((value) => value === undefined || typeof value === "string")).toBe(true);
  });
});
