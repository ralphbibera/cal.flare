type CalCsrfState =
  | { kind: "existing"; token: string; verified: boolean }
  | { kind: "created"; token: string; cookie: string; verified: false };

async function csrfHash(token: string, secret: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token + secret));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCalCsrfState({
  cookie,
  secret,
  submitted,
}: {
  cookie?: string | null;
  secret: string;
  submitted?: string;
}): Promise<CalCsrfState> {
  const [token, digest] = cookie?.split("|") ?? [];
  if (token && digest === (await csrfHash(token, secret))) {
    return { kind: "existing", token, verified: token === submitted };
  }
  const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return {
    kind: "created",
    token: generated,
    cookie: `${generated}|${await csrfHash(generated, secret)}`,
    verified: false,
  };
}
