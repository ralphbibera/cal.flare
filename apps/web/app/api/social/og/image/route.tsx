import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { App, Generic, getOGImageVersion, Meeting } from "@calcom/lib/OgImages";
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import type { ReactNode } from "react";
import { cloneElement, isValidElement } from "react";
import type { SatoriOptions } from "satori";
import { ZodError, z } from "zod";
import { fetchInternal } from "../../../../../worker/internal-fetch";

export const runtime = "edge";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

// On Workers, WEBAPP_URL points back at this same Worker and workerd rejects
// that self-request, so public assets are read from the ASSETS binding.
function isWorkersRuntime() {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

async function getAssetsBinding(): Promise<AssetsBinding | undefined> {
  if (!isWorkersRuntime()) return undefined;
  // @ts-expect-error The app tsconfig excludes the Worker runtime types that declare this module.
  const { env } = await import("cloudflare:workers");
  return env.ASSETS;
}

async function readOwnAsset(url: URL, assets: AssetsBinding | undefined): Promise<Response> {
  const assetUrl = new URL(url);
  assetUrl.pathname = assetUrl.pathname.replace(/\/{2,}/g, "/");
  const response = assets ? await assets.fetch(new Request(assetUrl)) : await fetch(assetUrl);
  if (!response.ok) throw new Error(`Unable to read ${assetUrl.pathname} (${response.status})`);
  return response;
}

async function readOwnImage(url: URL, assets: AssetsBinding): Promise<Response> {
  let target = new URL(url);
  for (let redirects = 0; redirects <= 20; redirects++) {
    if (!ownImageUrl(target.href)) return fetch(target);
    target.pathname = target.pathname.replace(/\/{2,}/g, "/");
    const response = await assets.fetch(new Request(target));
    // Dynamic avatars are served by app routes, which cannot self-fetch on Workers.
    const image = response.status === 404 ? await fetchInternal(new Request(target)) : response;
    const location = image.headers.get("location");
    if (image.status >= 300 && image.status < 400 && location) {
      target = new URL(location, target);
      continue;
    }
    if (!image.ok) {
      throw new ErrorWithCode(
        ErrorCode.InternalServerError,
        `Unable to read ${target.pathname} (${image.status})`
      );
    }
    return image;
  }
  throw new ErrorWithCode(ErrorCode.InternalServerError, "Too many OG image redirects");
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function ownImageUrl(source: string) {
  const url = new URL(source, WEBAPP_URL);
  return url.origin === new URL(WEBAPP_URL).origin ? url : undefined;
}

async function inlineBackgroundImage(
  backgroundImage: string,
  assets: AssetsBinding | undefined,
  sources: Map<string, Promise<string>>
) {
  const pattern = /url\(([^)]+)\)/g;
  const inlined = await Promise.all(
    Array.from(backgroundImage.matchAll(pattern), (match) => ownImageSource(match[1], assets, sources))
  );
  let index = 0;
  return backgroundImage.replace(pattern, () => `url(${inlined[index++]})`);
}

async function prepareImageTree(
  node: ReactNode,
  assets: AssetsBinding | undefined,
  sources: Map<string, Promise<string>>
): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child: ReactNode) => prepareImageTree(child, assets, sources)));
  }
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (typeof node.type === "function") {
    // The shared OG components render the host elements whose sources we inline.
    const component = node.type as (props: Record<string, unknown>) => ReactNode;
    return prepareImageTree(component(node.props), assets, sources);
  }

  const props = { ...node.props };
  if (node.type === "img") {
    // Vinext's Satori renderer rejects unitless numeric strings in image attributes.
    for (const dimension of ["width", "height"]) {
      const value = props[dimension];
      if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) continue;
      const size = Number(value);
      if (Number.isFinite(size)) props[dimension] = size;
    }
    if (typeof props.src === "string") {
      props.src = await ownImageSource(props.src, assets, sources);
    }
  }

  const style = props.style;
  if (style && typeof style === "object" && "backgroundImage" in style) {
    const backgroundImage = (style as { backgroundImage?: unknown }).backgroundImage;
    if (typeof backgroundImage === "string") {
      props.style = {
        ...style,
        backgroundImage: await inlineBackgroundImage(backgroundImage, assets, sources),
      };
    }
  }

  props.children = await prepareImageTree(props.children as ReactNode, assets, sources);
  return cloneElement(node, props);
}

async function ownImageSource(
  source: string,
  assets: AssetsBinding | undefined,
  sources: Map<string, Promise<string>>
) {
  const url = ownImageUrl(source);
  if (!url || !assets) return source;

  let dataUri = sources.get(url.href);
  if (!dataUri) {
    dataUri = readOwnImage(url, assets)
      .then(async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        // The avatar route labels stored JPEG bytes as image/png.
        const contentType =
          bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            ? "image/jpeg"
            : (response.headers.get("content-type") ?? "application/octet-stream");
        return `data:${contentType};base64,${toBase64(bytes)}`;
      })
      .catch(() => source);
    sources.set(url.href, dataUri);
  }
  return dataUri;
}

const meetingSchema = z.object({
  imageType: z.literal("meeting"),
  title: z.string(),
  names: z.string().array(),
  usernames: z.string().array(),
  meetingProfileName: z.string(),
  meetingImage: z.string().nullable().optional(),
});

const appSchema = z.object({
  imageType: z.literal("app"),
  name: z.string(),
  description: z.string(),
  slug: z.string(),
  logoUrl: z.string(),
});

const genericSchema = z.object({
  imageType: z.literal("generic"),
  title: z.string(),
  description: z.string(),
});

async function handler(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const imageType = searchParams.get("type");

  try {
    const assets = await getAssetsBinding();
    const fontResults = await Promise.allSettled([
      readOwnAsset(new URL("/fonts/cal.ttf", WEBAPP_URL), assets).then((response) => response.arrayBuffer()),
      readOwnAsset(new URL("/fonts/Inter-Regular.ttf", WEBAPP_URL), assets).then((response) =>
        response.arrayBuffer()
      ),
      readOwnAsset(new URL("/fonts/Inter-Medium.ttf", WEBAPP_URL), assets).then((response) =>
        response.arrayBuffer()
      ),
    ]);

    const fonts: SatoriOptions["fonts"] = [];

    if (fontResults[1].status === "fulfilled") {
      fonts.push({ name: "inter", data: fontResults[1].value, weight: 400 });
    }

    if (fontResults[2].status === "fulfilled") {
      fonts.push({ name: "inter", data: fontResults[2].value, weight: 500 });
    }

    if (fontResults[0].status === "fulfilled") {
      fonts.push({ name: "cal", data: fontResults[0].value, weight: 400 });
      fonts.push({ name: "cal", data: fontResults[0].value, weight: 600 });
    }

    const ogConfig = {
      width: 1200,
      height: 630,
      fonts,
    };

    const imageSources = new Map<string, Promise<string>>();
    const renderImage = async (element: ReactNode) => {
      const tree = await prepareImageTree(element, assets, imageSources);
      if (!isValidElement(tree)) throw new Error("OG image requires a React element");
      return new ImageResponse(tree, ogConfig);
    };

    switch (imageType) {
      case "meeting": {
        try {
          const { names, usernames, title, meetingProfileName, meetingImage } = meetingSchema.parse({
            names: searchParams.getAll("names"),
            usernames: searchParams.getAll("usernames"),
            title: searchParams.get("title"),
            meetingProfileName: searchParams.get("meetingProfileName"),
            meetingImage: searchParams.get("meetingImage"),
            imageType,
          });

          const etag = await getOGImageVersion("meeting");
          const img = await renderImage(
            <Meeting
              title={title}
              profile={{ name: meetingProfileName, image: meetingImage }}
              users={names.map((name, index) => ({ name, username: usernames[index] }))}
            />
          );

          return new Response(img.body, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control":
                "public, max-age=31536000, immutable, s-maxage=31536000, stale-while-revalidate=31536000",
              ETag: `"${etag}"`,
            },
          });
        } catch (error) {
          if (error instanceof ZodError) {
            return new Response(
              JSON.stringify({
                error: "Invalid parameters for meeting image",
                message:
                  "Required parameters: title, meetingProfileName. Optional: names, usernames, meetingImage",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
          throw error;
        }
      }
      case "app": {
        try {
          const { name, description, slug, logoUrl } = appSchema.parse({
            name: searchParams.get("name"),
            description: searchParams.get("description"),
            slug: searchParams.get("slug"),
            logoUrl: searchParams.get("logoUrl"),
            imageType,
          });

          // Get SVG hash for the app
          const svgHashesModule = await import("@calcom/web/public/app-store/svg-hashes.json");
          const SVG_HASHES = svgHashesModule.default ?? {};
          const svgHash = SVG_HASHES[slug] ?? undefined;

          const etag = await getOGImageVersion("app", { svgHash });
          const img = await renderImage(
            <App name={name} description={description} slug={slug} logoUrl={logoUrl} />
          );

          return new Response(img.body, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control":
                "public, max-age=31536000, immutable, s-maxage=31536000, stale-while-revalidate=31536000",
              ETag: `"${etag}"`,
            },
          });
        } catch (error) {
          if (error instanceof ZodError) {
            return new Response(
              JSON.stringify({
                error: "Invalid parameters for app image",
                message: "Required parameters: name, description, slug",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
          throw error;
        }
      }

      case "generic": {
        try {
          const { title, description } = genericSchema.parse({
            title: searchParams.get("title"),
            description: searchParams.get("description"),
            imageType,
          });

          const etag = await getOGImageVersion("generic");
          const img = await renderImage(<Generic title={title} description={description} />);

          return new Response(img.body, {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Cache-Control":
                "public, max-age=31536000, immutable, s-maxage=31536000, stale-while-revalidate=31536000",
              ETag: `"${etag}"`,
            },
          });
        } catch (error) {
          if (error instanceof ZodError) {
            return new Response(
              JSON.stringify({
                error: "Invalid parameters for generic image",
                message: "Required parameters: title, description",
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
          throw error;
        }
      }

      default:
        return new Response("Wrong image type", { status: 404 });
    }
  } catch {
    return new Response("Internal server error", { status: 500 });
  }
}

export { handler as GET };
