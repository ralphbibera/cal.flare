// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import type { Session } from "next-auth";
import { useSession as useNextAuthSession } from "next-auth/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCsrfToken,
  getProviders,
  getSession,
  SessionProvider,
  signIn,
  signOut,
  useSession,
} from "./index";

const session: Session = {
  hasValidLicense: false,
  upId: "up_1",
  user: { id: 1, name: "Ada", email: "ada@example.com", uuid: "user-uuid" },
};
const credentialsProvider = {
  id: "credentials",
  name: "Cal.flare",
  type: "credentials" as const,
  signinUrl: "/api/auth/signin/credentials",
  callbackUrl: "/api/auth/callback/credentials",
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function mockAuth(overrides: Record<string, () => Response> = {}) {
  const handlers: Record<string, () => Response> = {
    "/api/auth/providers": () => jsonResponse({ credentials: credentialsProvider }),
    "/api/auth/csrf": () => jsonResponse({ csrfToken: "csrf-1" }),
    ...overrides,
  };
  fetchMock.mockImplementation((url: string) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected ${url}`);
    return Promise.resolve(handler());
  });
}

const callsTo = (url: string) => fetchMock.mock.calls.filter(([called]) => called === url);

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_URL", "");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("@calcom/features/auth/client", () => {
  it("moves from loading to authenticated and updates the session", async () => {
    let resolveInitial!: (response: Response) => void;
    const initial = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/csrf") return Promise.resolve(jsonResponse({ csrfToken: "csrf-1" }));
      if (url !== "/api/auth/session") throw new Error(`unexpected ${url}`);
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ...session, user: { ...session.user, name: "Grace" } }));
      }
      return initial;
    });

    function Probe() {
      const { data, status, update } = useSession();
      return (
        <>
          <span data-testid="state">{`${status}:${data?.user.name ?? "none"}`}</span>
          <button type="button" onClick={() => void update({ name: "Grace" })}>
            update
          </button>
        </>
      );
    }

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>
    );
    expect(screen.getByTestId("state").textContent).toBe("loading:none");
    await act(async () => resolveInitial(jsonResponse(session)));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("authenticated:Ada"));

    await act(async () => screen.getByRole("button", { name: "update" }).click());
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("authenticated:Grace"));
    const post = callsTo("/api/auth/session").find(([, init]) => (init as RequestInit).method === "POST");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      csrfToken: "csrf-1",
      data: { name: "Grace" },
    });
  });

  it("resolves an empty session as unauthenticated and null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    function Probe() {
      const { data, status } = useSession();
      return <span data-testid="state">{`${status}:${String(data)}`}</span>;
    }
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>
    );
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("unauthenticated:null"));
    await expect(getSession()).resolves.toBeNull();
  });

  it("signs in with credentials, posting CSRF and fields, and returns the next-auth response", async () => {
    let call = 0;
    mockAuth({
      "/api/auth/callback/credentials": () =>
        call++ === 0
          ? jsonResponse({ url: "http://localhost:3000/api/auth/error?error=incorrect-email-password" }, 401)
          : jsonResponse({ url: "http://localhost:3000/bookings" }),
    });

    const options = {
      redirect: false,
      callbackUrl: "/bookings",
      email: "ada@example.com",
      password: "secret",
    };
    await expect(signIn("credentials", options)).resolves.toEqual({
      error: "incorrect-email-password",
      status: 401,
      ok: false,
      url: null,
    });
    await expect(signIn("credentials", options)).resolves.toEqual({
      error: null,
      status: 200,
      ok: true,
      url: "http://localhost:3000/bookings",
    });

    const init = callsTo("/api/auth/callback/credentials")[0][1] as RequestInit;
    const body = init.body as URLSearchParams;
    expect(body.get("csrfToken")).toBe("csrf-1");
    expect(body.get("email")).toBe("ada@example.com");
    expect(body.get("password")).toBe("secret");
    expect(body.get("callbackUrl")).toBe("/bookings");
    expect(body.get("redirect")).toBe("false");
    expect(body.get("json")).toBe("true");
    expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    await expect(getProviders()).resolves.toEqual({ credentials: credentialsProvider });
    await expect(getCsrfToken()).resolves.toBe("csrf-1");
  });

  it("redirects after sign-in by default", async () => {
    const location = {
      href: "http://localhost:3000/login",
      origin: "http://localhost:3000",
      reload: vi.fn(),
    };
    vi.stubGlobal("location", location);
    mockAuth({
      "/api/auth/callback/credentials": () => jsonResponse({ url: "http://localhost:3000/bookings" }),
    });

    await signIn("credentials", { email: "ada@example.com", password: "secret" });
    expect(location.href).toBe("http://localhost:3000/bookings");
    expect(location.reload).not.toHaveBeenCalled();
  });

  it("signs out with CSRF and returns the response without redirecting", async () => {
    mockAuth({ "/api/auth/signout": () => jsonResponse({ url: "/auth/logout" }) });
    await expect(signOut({ redirect: false, callbackUrl: "/auth/logout" })).resolves.toEqual({
      url: "/auth/logout",
    });
    const body = (callsTo("/api/auth/signout")[0][1] as RequestInit).body as URLSearchParams;
    expect(body.get("csrfToken")).toBe("csrf-1");
    expect(body.get("callbackUrl")).toBe("/auth/logout");
    expect(body.get("json")).toBe("true");
  });

  it("keeps next-auth useSession working under the shared provider", async () => {
    fetchMock.mockResolvedValue(jsonResponse(session));
    function LegacyProbe() {
      const { data, status } = useNextAuthSession();
      return <span data-testid="legacy">{`${status}:${data?.user.name}`}</span>;
    }
    render(
      <SessionProvider>
        <LegacyProbe />
      </SessionProvider>
    );
    await waitFor(() => expect(screen.getByTestId("legacy").textContent).toBe("authenticated:Ada"));
  });
});
