import fresh from "fresh";
import parseRange from "range-parser";

export interface SplitStaticAsset {
  size: number;
  contentType: string;
  etag: string;
  lastModified: string;
  parts: { path: string; size: number }[];
}

interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

function matches(value: string, etag: string): boolean {
  return (
    value === "*" ||
    value.split(",").some((token) => {
      const candidate = token.trim();
      return candidate === etag || candidate === "W/" + etag || "W/" + candidate === etag;
    })
  );
}

function errorResponse(request: Request, status: 412 | 416, size: number): Response {
  const message = status === 412 ? "Precondition Failed" : "Range Not Satisfiable";
  const body =
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>' +
    message +
    "</pre>\n</body>\n</html>\n";
  const headers = new Headers({
    "Content-Type": "text/html; charset=UTF-8",
    "Content-Length": String(new TextEncoder().encode(body).length),
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  if (status === 416) headers.set("Content-Range", "bytes */" + size);
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

async function serve(request: Request, asset: SplitStaticAsset, assets: AssetsFetcher): Promise<Response> {
  const headers = new Headers({
    "Content-Type": asset.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=0",
    ETag: asset.etag,
    "Last-Modified": asset.lastModified,
  });
  const ifMatch = request.headers.get("if-match");
  const unmodified = request.headers.get("if-unmodified-since");
  if (
    ifMatch
      ? !matches(ifMatch, asset.etag)
      : unmodified && Date.parse(asset.lastModified) > Date.parse(unmodified)
  ) {
    return errorResponse(request, 412, asset.size);
  }
  if (fresh(Object.fromEntries(request.headers), { etag: asset.etag, "last-modified": asset.lastModified })) {
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }

  let start = 0;
  let end = asset.size - 1;
  let status = 200;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const rangeFresh =
    !ifRange ||
    (ifRange.includes('"')
      ? ifRange.includes(asset.etag)
      : Date.parse(asset.lastModified) <= Date.parse(ifRange));
  if (range && /^ *bytes=/.test(range) && rangeFresh) {
    const ranges = parseRange(asset.size, range, { combine: true });
    if (ranges === -1) return errorResponse(request, 416, asset.size);
    if (ranges !== -2 && ranges.length === 1) {
      ({ start, end } = ranges[0]);
      status = 206;
      headers.set("Content-Range", "bytes " + start + "-" + end + "/" + asset.size);
    }
  }
  const length = end - start + 1;
  headers.set("Content-Length", String(length));
  if (request.method === "HEAD") return new Response(null, { status, headers });

  let position = 0;
  const selected = asset.parts.flatMap((part) => {
    const offset = position;
    position += part.size;
    if (position <= start || offset > end) return [];
    return [
      {
        ...part,
        skip: Math.max(0, start - offset),
        left: Math.min(position - 1, end) - Math.max(offset, start) + 1,
      },
    ];
  });
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = new AbortController();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (index < selected.length) {
          const part = selected[index];
          if (!reader) {
            const partHeaders = new Headers(request.headers);
            for (const name of [
              "range",
              "if-range",
              "if-match",
              "if-none-match",
              "if-modified-since",
              "if-unmodified-since",
            ]) {
              partHeaders.delete(name);
            }
            partHeaders.set("accept-encoding", "identity");
            const response = await assets.fetch(
              new Request(new URL(part.path, request.url), {
                headers: partHeaders,
                signal: AbortSignal.any([request.signal, abort.signal]),
              })
            );
            if (cancelled) {
              await response.body?.cancel();
              return;
            }
            if (response.status !== 200 || !response.body)
              throw new Error("Static asset part is unavailable");
            reader = response.body.getReader();
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Static asset part ended before its declared length");
          if (part.skip >= chunk.value.length) {
            part.skip -= chunk.value.length;
            continue;
          }
          const count = Math.min(part.left, chunk.value.length - part.skip);
          controller.enqueue(chunk.value.subarray(part.skip, part.skip + count));
          part.skip = 0;
          part.left -= count;
          if (part.left === 0) {
            await reader.cancel();
            reader = undefined;
            index++;
          }
          return;
        }
        controller.close();
      } catch (error) {
        await reader?.cancel(error);
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      abort.abort(reason);
      await reader?.cancel(reason);
    },
  });
  return new Response(source, { status, headers });
}

export function frameStaticAsset(
  response: Response,
  manifest: Readonly<Record<string, SplitStaticAsset>>
): Response {
  const asset = Object.values(manifest).find((entry) => entry.etag === response.headers.get("etag"));
  if (!asset || !response.body || (response.status !== 200 && response.status !== 206)) return response;
  const length = Number(response.headers.get("content-length") ?? asset.size);
  const fixed = new FixedLengthStream(length);
  // Apply framing after framework and telemetry stream wrappers have finished.
  void response.body.pipeTo(fixed.writable).catch(() => {});
  const headers = new Headers(response.headers);
  headers.set("content-length", String(length));
  return new Response(fixed.readable, { status: response.status, statusText: response.statusText, headers });
}

export function withStaticAssets<T extends { ASSETS?: AssetsFetcher }>(
  env: T,
  manifest: Readonly<Record<string, SplitStaticAsset>>
): T {
  const assets = env.ASSETS;
  if (!assets) throw new Error("ASSETS binding is required");
  return {
    ...env,
    ASSETS: new Proxy(assets, {
      get(target, property) {
        if (property !== "fetch") return Reflect.get(target, property, target);
        return (request: Request) => {
          const asset = manifest[new URL(request.url).pathname];
          return asset && (request.method === "GET" || request.method === "HEAD")
            ? serve(request, asset, target)
            : target.fetch(request);
        };
      },
    }),
  };
}
