import { type BookingAccess, ErrorWithCode } from "./bookings.ts";

function parse(value: unknown): Readonly<BookingAccess> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.id) ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token)
  )
    throw new ErrorWithCode("invalid_access", 400);
  return Object.freeze({ id: value.id, token: value.token });
}

export function managementLink(access: BookingAccess, origin: string): string {
  const validated = parse(access),
    url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
    throw new ErrorWithCode("invalid_origin", 400);
  return `${origin}/booking/${validated.id}#token=${validated.token}`;
}

export function restoreManagementAccess({
  id,
  fragment,
  storage,
}: {
  id: string;
  fragment: string;
  storage: Pick<Storage, "getItem" | "setItem">;
}): Readonly<BookingAccess> {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new ErrorWithCode("invalid_access", 400);
  const key = `calflare:manage:v1:${id}`;
  if (fragment) {
    const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(fragment);
    if (!match) throw new ErrorWithCode("invalid_access", 400);
    const access = parse({ id, token: match[1] });
    try {
      storage.setItem(key, JSON.stringify(access));
    } catch {
      throw new ErrorWithCode("storage_unavailable", 0);
    }
    return access;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw new ErrorWithCode("storage_unavailable", 0);
  }
  try {
    if (raw === null || raw.length > 512) throw new Error();
    const access = parse(JSON.parse(raw));
    if (access.id !== id) throw new Error();
    return access;
  } catch {
    throw new ErrorWithCode("invalid_access", 400);
  }
}
