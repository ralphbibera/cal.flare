import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";
import { cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import type { SatoriOptions } from "satori";
import { z, ZodError } from "zod";

import { Meeting, App, Generic, getOGImageVersion } from "@calcom/lib/OgImages";
import { WEBAPP_URL } from "@calcom/lib/constants";

export const runtime = "edge";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

// On Workers the route's own WEBAPP_URL points back at the same Worker, and
// workerd rejects that self-request, so the public fonts, backgrounds and logos
// are read from the ASSETS binding instead of over HTTP.
function isWorkersRuntime() {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

async function getAssetsBinding(): Promise<AssetsBinding | undefined> {
  if (!isWorkersRuntime()) return undefined;
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

async function inlineOwnImages(
  node: ReactNode,
  assets: AssetsBinding | undefined,
  sources: Map<string, Promise<string>>
): Promise<ReactNode> {
  if (Array.isArray(node)) {
    return Promise.all(node.map((child: ReactNode) => inlineOwnImages(child, assets, sources)));
  }
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const component = renderFunctionComponent(node);
  if (component !== undefined) return inlineOwnImages(component, assets, sources);

  const props = { ...node.props };
  if (typeof props.src === "string") {
    props.src = await ownImageSource(props.src, assets, sources);
  }
  if (node.type === "img") {
    // Satori rejects the string width/height attributes the shared OG components
    // pass and renders those images without a size.
    for (const dimension of ["width", "height"] as const) {
      const value = props[dimension];
      if (typeof value === "string" && /^\d+$/.test(value)) props[dimension] = Number(value);
    }
  }
  const style = props.style;
  if (style && typeof style === "object" && "backgroundImage" in style) {
    const backgroundImage = (style as { backgroundImage?: unknown }).backgroundImage;
    if (typeof backgroundImage === "string") {
      const replaced = await Promise.all(
        Array.from(backgroundImage.matchAll(/url\(([^)]+)\)/g), async (match) => {
          const source = await ownImageSource(match[1], assets, sources);
          return [match[0], `url(${source})`] as const;
        })
      );
      props.style = {
        ...style,
        backgroundImage: replaced.reduce((value, [from, to]) => value.replace(from, to), backgroundImage),
      };
    }
  }
  if (props.children) {
    props.children = await inlineOwnImages(props.children as ReactNode, assets, sources);
  }
  return cloneElement(node, props);
}

// The shared OG components are function components; resolving them lets the
// walker reach the host elements whose sources must be inlined.
function renderFunctionComponent(node: ReactElement<Record<string, unknown>>): ReactNode | undefined {
  const type = node.type as unknown;
  if (typeof type !== "function") return undefined;
  return (type as (props: Record<string, unknown>) => ReactNode)(node.props);
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
    dataUri = readOwnAsset(url, assets)
      .then(async (response) => {
        const contentType = response.headers.get("content-type") ?? "application/octet-stream";
        return `data:${contentType};base64,${toBase64(new Uint8Array(await response.arrayBuffer()))}`;
      })
      // Dynamic same-origin images such as avatars are not Static Assets, so
      // keep the source URL and let the image loader request it normally.
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
      const tree = await inlineOwnImages(element, assets, imageSources);
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
            Meeting({
              title,
              profile: { name: meetingProfileName, image: meetingImage },
              users: names.map((name, index) => ({ name, username: usernames[index] })),
            })
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
          const img = await renderImage(App({ name, description, slug, logoUrl }));

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
          const img = await renderImage(Generic({ title, description }));

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
