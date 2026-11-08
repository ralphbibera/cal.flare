import qs from "qs";

function mediaType(request: Request): string {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new BodyModeError(413, "request entity too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw new BodyModeError(413, "request entity too large");
  return bytes;
}

function readJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new BodyModeError(400, error instanceof Error ? error.message : "invalid JSON body");
  }
  // body-parser's strict mode only accepts arrays and objects.
  if (typeof body !== "object" || body === null) {
    throw new BodyModeError(400, "invalid JSON body");
  }
  return body;
}

/** body-parser's default limit for json, urlencoded and raw bodies. */
export const BODY_LIMIT_BYTES: number = 100 * 1024;

export type BodyMode = "json" | "urlencoded" | "raw" | "none";

export class BodyModeError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string
  ) {
    super(message);
    this.name = "BodyModeError";
  }
}

/**
 * Mirrors the body-parser configuration the Node host applies in app.module.ts:
 * json() and urlencoded({ extended: true }) at the default 100 KB limit, plus raw bodies of every content type.
 */
export async function readBody({
  mode,
  request,
  limit = BODY_LIMIT_BYTES,
}: {
  mode: BodyMode;
  request: Request;
  limit?: number;
}): Promise<unknown> {
  switch (mode) {
    case "none":
      return undefined;
    case "json":
      if (mediaType(request) !== "application/json") return undefined;
      return readJson(await readBytes(request, limit));
    case "urlencoded":
      if (mediaType(request) !== "application/x-www-form-urlencoded") return undefined;
      return qs.parse(new TextDecoder().decode(await readBytes(request, limit)), {
        arrayLimit: 1000,
        depth: 32,
        parameterLimit: 1000,
      });
    case "raw":
      return readBytes(request, limit);
  }
}
