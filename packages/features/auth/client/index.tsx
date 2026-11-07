import type { Session } from "next-auth";
import type { BuiltInProviderType, RedirectableProviderType } from "next-auth/providers";
import type {
  ClientSafeProvider,
  GetSessionParams,
  LiteralUnion,
  SessionProviderProps,
  SignInAuthorizationParams,
  SignInOptions,
  SignInResponse,
  SignOutParams,
  SignOutResponse,
  UseSessionOptions,
} from "next-auth/react";
import { SessionContext as NextAuthSessionContext } from "next-auth/react";
import * as React from "react";

type ProvidersMap = Partial<Record<LiteralUnion<BuiltInProviderType, string>, ClientSafeProvider>>;
type SignInResult<P extends RedirectableProviderType | undefined> = P extends RedirectableProviderType
  ? SignInResponse | undefined
  : undefined;

const DEFAULT_BASE_PATH = "/api/auth";
let basePathOverride: string | undefined;

const clientState: {
  session: Session | null | undefined;
  lastSync: number;
  refetch: (options?: { event?: string }) => Promise<void>;
} = {
  session: undefined,
  lastSync: 0,
  refetch: async () => {},
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function authPath(url?: string) {
  if (!url) return DEFAULT_BASE_PATH;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.pathname === "/" ? DEFAULT_BASE_PATH : parsed.pathname.replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_PATH;
  }
}

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

function authBaseUrl() {
  const serverUrl = env?.NEXTAUTH_URL_INTERNAL ?? env?.NEXTAUTH_URL ?? env?.VERCEL_URL;
  if (typeof window !== "undefined")
    return basePathOverride ?? authPath(env?.NEXTAUTH_URL ?? env?.VERCEL_URL);
  if (!serverUrl) return `http://localhost:3000${DEFAULT_BASE_PATH}`;
  const absolute = serverUrl.startsWith("http") ? serverUrl : `https://${serverUrl}`;
  try {
    return `${new URL(absolute).origin}${authPath(serverUrl)}`;
  } catch {
    return `http://localhost:3000${DEFAULT_BASE_PATH}`;
  }
}

async function fetchData<T>(path: string, params?: GetSessionParams): Promise<T | null> {
  const req = params?.req ?? params?.ctx?.req;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req?.headers?.cookie) headers.cookie = req.headers.cookie;
  try {
    const res = await fetch(`${authBaseUrl()}/${path}`, { headers });
    const data = (await res.json()) as Record<string, unknown> | null;
    if (!res.ok) throw data;
    return (data && Object.keys(data).length > 0 ? data : null) as T | null;
  } catch {
    return null;
  }
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${authBaseUrl()}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

export type {
  ClientSafeProvider,
  GetSessionParams,
  LiteralUnion,
  SessionProviderProps,
  SignInAuthorizationParams,
  SignInOptions,
  SignInResponse,
  SignOutParams,
  SignOutResponse,
  UseSessionOptions,
};

export type UpdateSession = (data?: unknown) => Promise<Session | null>;

export type SessionContextValue<R extends boolean = false> = R extends true
  ?
      | { update: UpdateSession; data: Session; status: "authenticated" }
      | { update: UpdateSession; data: null; status: "loading" }
  :
      | { update: UpdateSession; data: Session; status: "authenticated" }
      | { update: UpdateSession; data: null; status: "unauthenticated" | "loading" };

// Share next-auth's context so existing next-auth/react hooks keep working here.
export const SessionContext = NextAuthSessionContext as unknown as React.Context<
  SessionContextValue | undefined
>;

export function useSession<R extends boolean = false>(
  options?: UseSessionOptions<R>
): SessionContextValue<R> {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error("[cal-auth]: `useSession` must be wrapped in a <SessionProvider />");
  const required = options?.required && value.status === "unauthenticated";
  const onUnauthenticated = options?.onUnauthenticated;

  React.useEffect(() => {
    if (!required) return;
    if (onUnauthenticated) return onUnauthenticated();
    window.location.href = `${DEFAULT_BASE_PATH}/signin?${new URLSearchParams({
      error: "SessionRequired",
      callbackUrl: window.location.href,
    })}`;
  }, [required, onUnauthenticated]);

  if (required) return { data: null, update: value.update, status: "loading" } as SessionContextValue<R>;
  return value as SessionContextValue<R>;
}

export async function getSession(params?: GetSessionParams): Promise<Session | null> {
  return fetchData<Session>("get-session", params);
}

// Better Auth guards state changes with origin checks instead of a CSRF token.
export async function getCsrfToken(_params?: GetSessionParams): Promise<string | undefined> {
  return undefined;
}

// Only Cal credentials are served natively until the email and OAuth steps land.
export async function getProviders(): Promise<ProvidersMap | null> {
  return {
    credentials: {
      id: "credentials",
      name: "Cal.flare",
      type: "credentials",
      signinUrl: `${authBaseUrl()}/sign-in/cal-credentials`,
      callbackUrl: `${authBaseUrl()}/sign-in/cal-credentials`,
    },
  };
}

export async function signIn<P extends RedirectableProviderType | undefined = undefined>(
  provider?: LiteralUnion<P extends RedirectableProviderType ? P | BuiltInProviderType : BuiltInProviderType>,
  options?: SignInOptions,
  _authorizationParams?: SignInAuthorizationParams
): Promise<SignInResult<P>> {
  const { callbackUrl = window.location.href, redirect = true } = options ?? {};
  if (provider !== "credentials") {
    const error = provider === "email" ? "EmailSignin" : "OAuthSignin";
    window.location.href = `/auth/error?${new URLSearchParams({ error })}`;
    return undefined as SignInResult<P>;
  }

  const credentials: Record<string, string> = {};
  for (const field of ["email", "password", "totpCode", "backupCode"] as const) {
    const value = options?.[field];
    if (value !== undefined && value !== null) credentials[field] = String(value);
  }
  const res = await postJson("sign-in/cal-credentials", { ...credentials, callbackUrl });
  const data = await readJson<{ url?: string; message?: string }>(res);
  const error = res.ok ? null : (data.message ?? "internal-server-error");

  if (redirect) {
    const target = error ? `/auth/error?${new URLSearchParams({ error })}` : (data.url ?? callbackUrl);
    window.location.href = target;
    if (target.includes("#")) window.location.reload();
    return undefined as SignInResult<P>;
  }

  if (res.ok) await clientState.refetch({ event: "storage" });
  return {
    error,
    status: res.status,
    ok: res.ok,
    url: error ? null : (data.url ?? null),
  } as SignInResult<P>;
}

export async function signOut<R extends boolean = true>(
  options?: SignOutParams<R>
): Promise<R extends true ? undefined : SignOutResponse> {
  const { callbackUrl = window.location.href } = options ?? {};
  await postJson("sign-out", {});

  if (options?.redirect ?? true) {
    window.location.href = callbackUrl;
    if (callbackUrl.includes("#")) window.location.reload();
    return undefined as R extends true ? undefined : SignOutResponse;
  }
  await clientState.refetch({ event: "storage" });
  return { url: callbackUrl } as R extends true ? undefined : SignOutResponse;
}

export function SessionProvider(props: SessionProviderProps) {
  if (props.basePath) basePathOverride = props.basePath;
  const hasInitialSession = props.session !== undefined;
  const [session, setSession] = React.useState<Session | null>(() => {
    if (hasInitialSession) {
      clientState.session = props.session;
      clientState.lastSync = now();
    }
    return props.session ?? null;
  });
  const [loading, setLoading] = React.useState(!hasInitialSession);

  React.useEffect(() => {
    clientState.refetch = async ({ event } = {}) => {
      const storageEvent = event === "storage";
      try {
        if (storageEvent || clientState.session === undefined) {
          clientState.lastSync = now();
          clientState.session = await getSession({ broadcast: !storageEvent });
          setSession(clientState.session);
          return;
        }
        if (!event || clientState.session === null || now() < clientState.lastSync) return;
        clientState.lastSync = now();
        clientState.session = await getSession();
        setSession(clientState.session);
      } finally {
        setLoading(false);
      }
    };
    void clientState.refetch();
    return () => {
      clientState.lastSync = 0;
      clientState.session = undefined;
      clientState.refetch = async () => {};
    };
  }, []);

  const update = React.useCallback(
    async (data?: unknown) => {
      if (loading || !session) return null;
      setLoading(true);
      try {
        const res = await postJson("cal/update-session", { data });
        const nextSession = res.ok ? await readJson<Session>(res) : null;
        if (nextSession) {
          clientState.session = nextSession;
          setSession(nextSession);
        }
        return nextSession;
      } finally {
        setLoading(false);
      }
    },
    [loading, session]
  );

  const value = React.useMemo<SessionContextValue>(() => {
    if (loading) return { data: null, status: "loading", update };
    if (session) return { data: session, status: "authenticated", update };
    return { data: null, status: "unauthenticated", update };
  }, [loading, session, update]);

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}
