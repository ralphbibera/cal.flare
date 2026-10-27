export class ErrorWithCode extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ErrorWithCode";
  }
}

const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function hash(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
export async function encryptionKey(encoded: string): Promise<CryptoKey> {
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error();
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== encoded) throw new Error();
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    throw new ErrorWithCode("CONFIGURATION", "TOKEN_ENCRYPTION_KEY must be canonical base64 for 32 bytes");
  }
}
export async function seal(key: CryptoKey, value: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(`calflare:v1:${context}`) },
    key,
    encoder.encode(value)
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function unseal(key: CryptoKey, value: string, context: string): Promise<string> {
  try {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw new Error();
    const decode = (s: string) =>
      Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const iv = decode(parts[1]);
    if (iv.length !== 12) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(`calflare:v1:${context}`) },
        key,
        decode(parts[2])
      )
    );
  } catch {
    throw new ErrorWithCode("TOKEN_STORAGE", "Encrypted credential could not be authenticated");
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ErrorWithCode("UPSTREAM_SHAPE", "Expected an upstream object");
  }
  return value as Record<string, unknown>;
}
export function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new ErrorWithCode("UPSTREAM_SHAPE", "Expected a nonempty string");
  return value;
}
