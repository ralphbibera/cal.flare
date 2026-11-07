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

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function mockAuth(overrides: Record<string, () => Response> = {}) {
  fetchMock.mockImplementation((url: string) => {
    const handler = overrides[url];
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
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/auth/cal/update-session") {
        return Promise.resolve(jsonResponse({ ...session, user: { ...session.user, name: "Grace" } }));
      }
      if (url !== "/api/auth/get-session") throw new Error(`unexpected ${url}`);
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
    const post = callsTo("/api/auth/cal/update-session")[0];
    expect((post[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ data: { name: "Grace" } });
  });

  it("resolves an empty session as unauthenticated and null", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null));
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

  it("signs in with credentials as JSON and returns the next-auth response shape", async () => {
    let call = 0;
    mockAuth({
      "/api/auth/sign-in/cal-credentials": () =>
        call++ === 0
          ? jsonResponse({ code: "INCORRECT_EMAIL_PASSWORD", message: "incorrect-email-password" }, 401)
          : jsonResponse({ redirect: true, url: "http://localhost:3000/bookings", user: { id: 1 } }),
    });

    const options = {
      redirect: false,
      callbackUrl: "/bookings",
      email: "ada@example.com",
      password: "secret",
      totpCode: "123456",
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

    const init = callsTo("/api/auth/sign-in/cal-credentials")[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      email: "ada@example.com",
      password: "secret",
      totpCode: "123456",
      callbackUrl: "/bookings",
    });
    await expect(getProviders()).resolves.toMatchObject({ credentials: { id: "credentials" } });
    await expect(getCsrfToken()).resolves.toBeUndefined();
  });

  it("redirects after sign-in by default and to the error page on failure", async () => {
    const location = {
      href: "http://localhost:3000/login",
      origin: "http://localhost:3000",
      reload: vi.fn(),
    };
    vi.stubGlobal("location", location);
    let call = 0;
    mockAuth({
      "/api/auth/sign-in/cal-credentials": () =>
        call++ === 0
          ? jsonResponse({ redirect: true, url: "http://localhost:3000/bookings" })
          : jsonResponse({ message: "second-factor-required" }, 401),
    });

    await signIn("credentials", { email: "ada@example.com", password: "secret" });
    expect(location.href).toBe("http://localhost:3000/bookings");
    expect(location.reload).not.toHaveBeenCalled();
    await signIn("credentials", { email: "ada@example.com", password: "secret" });
    expect(location.href).toBe("/auth/error?error=second-factor-required");
  });

  it("sends providers that are not served natively to the auth error page", async () => {
    const location = {
      href: "http://localhost:3000/login",
      origin: "http://localhost:3000",
      reload: vi.fn(),
    };
    vi.stubGlobal("location", location);
    await signIn("google");
    expect(location.href).toBe("/auth/error?error=OAuthSignin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts native sign-out and returns the callback without redirecting", async () => {
    mockAuth({ "/api/auth/sign-out": () => jsonResponse({ success: true }) });
    await expect(signOut({ redirect: false, callbackUrl: "/auth/logout" })).resolves.toEqual({
      url: "/auth/logout",
    });
    const init = callsTo("/api/auth/sign-out")[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
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
