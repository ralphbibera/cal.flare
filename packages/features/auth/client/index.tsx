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

type ProvidersMap = Record<LiteralUnion<BuiltInProviderType, string>, ClientSafeProvider>;
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
  const options: RequestInit = { headers };
  if (req?.body) {
    options.body = JSON.stringify(req.body);
    options.method = "POST";
  }
  try {
    const res = await fetch(`${authBaseUrl()}/${path}`, options);
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw data;
    return (Object.keys(data).length > 0 ? data : null) as T | null;
  } catch {
    return null;
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
  return fetchData<Session>("session", params);
}

export async function getCsrfToken(params?: GetSessionParams): Promise<string | undefined> {
  const data = await fetchData<{ csrfToken?: string }>("csrf", params);
  return data?.csrfToken;
}

export async function getProviders(): Promise<ProvidersMap | null> {
  return fetchData<ProvidersMap>("providers");
}

export async function signIn<P extends RedirectableProviderType | undefined = undefined>(
  provider?: LiteralUnion<P extends RedirectableProviderType ? P | BuiltInProviderType : BuiltInProviderType>,
  options?: SignInOptions,
  authorizationParams?: SignInAuthorizationParams
): Promise<SignInResult<P>> {
  const { callbackUrl = window.location.href, redirect = true } = options ?? {};
  const baseUrl = authBaseUrl();
  const providers = await getProviders();
  if (!providers) {
    window.location.href = `${baseUrl}/error`;
    return undefined as P extends RedirectableProviderType ? SignInResponse | undefined : undefined;
  }
  const selected = provider ? providers[provider] : undefined;
  if (!selected) {
    window.location.href = `${baseUrl}/signin?${new URLSearchParams({ callbackUrl })}`;
    return undefined as P extends RedirectableProviderType ? SignInResponse | undefined : undefined;
  }

  const isCredentials = selected.type === "credentials";
  const isEmail = selected.type === "email";
  const signInUrl = `${baseUrl}/${isCredentials ? "callback" : "signin"}/${provider}`;
  const url = authorizationParams ? `${signInUrl}?${new URLSearchParams(authorizationParams)}` : signInUrl;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries({
    ...options,
    csrfToken: await getCsrfToken(),
    callbackUrl,
    json: true,
  })) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }
  const res = await fetch(url, {
    method: "post",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as { url?: string };

  if (redirect || !(isCredentials || isEmail)) {
    const target = data.url ?? callbackUrl;
    window.location.href = target;
    if (target.includes("#")) window.location.reload();
    return undefined as P extends RedirectableProviderType ? SignInResponse | undefined : undefined;
  }

  const error = data.url ? new URL(data.url, window.location.origin).searchParams.get("error") : null;
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
  const baseUrl = authBaseUrl();
  const body = new URLSearchParams({
    csrfToken: (await getCsrfToken()) ?? "",
    callbackUrl,
    json: "true",
  });
  const res = await fetch(`${baseUrl}/signout`, {
    method: "post",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as SignOutResponse;

  if (options?.redirect ?? true) {
    const target = data.url ?? callbackUrl;
    window.location.href = target;
    if (target.includes("#")) window.location.reload();
    return undefined as R extends true ? undefined : SignOutResponse;
  }
  await clientState.refetch({ event: "storage" });
  return data as R extends true ? undefined : SignOutResponse;
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
        const csrfToken = await getCsrfToken();
        const nextSession = await getSession({ req: { body: { csrfToken, data } } });
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
