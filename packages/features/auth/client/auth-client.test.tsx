// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = {
  expires: "2030-01-01T00:00:00.000Z",
  hasValidLicense: false,
  upId: "up_1",
  profileId: null,
  user: { id: 1, name: "Ada", email: "ada@example.com", uuid: "user-uuid" },
};

// The client resolves `fetch` when it is created, so the mock is installed before the module loads.
const fetchMock = vi.hoisted(() => {
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  return mock;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockAuth(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation((input: Request | string | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost:3000");
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected ${url.pathname}`);
    return Promise.resolve(route());
  });
}

function requestsTo(pathname: string) {
  return fetchMock.mock.calls
    .filter(
      ([input]) =>
        new URL(input instanceof Request ? input.url : String(input), "http://localhost:3000").pathname ===
        pathname
    )
    .map(([, init]) => ({ method: (init?.method ?? "GET") as string, body: (init?.body ?? "") as string }));
}

let authClient: typeof import("./auth-client").authClient;

// The session atom is module state, so each test gets a fresh client.
beforeEach(async () => {
  fetchMock.mockReset();
  vi.resetModules();
  ({ authClient } = await import("./auth-client"));
});

describe("@calcom/features/auth/client/auth-client", () => {
  it("moves useSession from pending to the Cal session and refetches after an update", async () => {
    let name = "Ada";
    mockAuth({
      "/api/auth/get-session": () => jsonResponse({ ...session, user: { ...session.user, name } }),
      "/api/auth/cal/update-session": () => {
        name = "Grace";
        return jsonResponse({ ...session, user: { ...session.user, name } });
      },
    });

    function Probe() {
      const { data, isPending } = authClient.useSession();
      return (
        <>
          <span data-testid="state">{`${isPending ? "pending" : "settled"}:${data?.user.name ?? "none"}`}</span>
          <button
            type="button"
            onClick={() => void authClient.cal.updateSession({ data: { name: "Grace" } })}>
            update
          </button>
        </>
      );
    }

    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe("pending:none");
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("settled:Ada"));

    await act(async () => screen.getByRole("button", { name: "update" }).click());
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("settled:Grace"));
    const [post] = requestsTo("/api/auth/cal/update-session");
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body)).toEqual({ data: { name: "Grace" } });
  });

  it("settles an empty session as null", async () => {
    mockAuth({ "/api/auth/get-session": () => jsonResponse(null) });
    function Probe() {
      const { data, isPending } = authClient.useSession();
      return <span data-testid="state">{`${isPending ? "pending" : "settled"}:${String(data)}`}</span>;
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("settled:null"));
  });

  it("signs in with Cal credentials as JSON and surfaces Cal's error code", async () => {
    let call = 0;
    mockAuth({
      "/api/auth/sign-in/cal-credentials": () =>
        call++ === 0
          ? jsonResponse({ code: "INCORRECT_EMAIL_PASSWORD", message: "incorrect-email-password" }, 401)
          : jsonResponse({ redirect: false, url: "http://localhost:3000", user: { id: 1 } }),
    });

    const body = { email: "ada@example.com", password: "secret", totpCode: "123456" };
    const failed = await authClient.signIn.calCredentials(body);
    expect(failed.error?.message).toBe("incorrect-email-password");
    expect(failed.error?.status).toBe(401);

    const signedIn = await authClient.signIn.calCredentials(body);
    expect(signedIn.error).toBeNull();
    expect(signedIn.data?.user.id).toBe(1);

    const [first] = requestsTo("/api/auth/sign-in/cal-credentials");
    expect(first.method).toBe("POST");
    expect(JSON.parse(first.body)).toEqual(body);
  });

  it("posts native sign-out", async () => {
    mockAuth({ "/api/auth/sign-out": () => jsonResponse({ success: true }) });
    const { data } = await authClient.signOut();
    expect(data).toEqual({ success: true });
    const [post] = requestsTo("/api/auth/sign-out");
    expect(post.method).toBe("POST");
  });
});
