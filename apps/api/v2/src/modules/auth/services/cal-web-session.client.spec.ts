import { ConfigService } from "@nestjs/config";
import { CalWebSessionClient, WEB_SESSION_TIMEOUT_MS } from "./cal-web-session.client";

describe("CalWebSessionClient", () => {
  const webAppUrl = "https://app.example.com";
  const sessionCookie = "better-auth.session_token=abc.def";
  const secureSessionCookie = "__Secure-better-auth.session_token=ghi.jkl";
  let fetchMock: jest.SpyInstance;
  let client: CalWebSessionClient;

  function respondWith(body: unknown, status = 200) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }

  function lastRequest() {
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    return { url, init };
  }

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch");
    client = new CalWebSessionClient({ get: () => webAppUrl } as unknown as ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns the signed-in user's id and email", async () => {
    respondWith({ user: { id: 7, email: "user@example.com", name: "User" }, upId: "usr-7" });

    await expect(client.getSession({ headers: { cookie: sessionCookie } })).resolves.toEqual({
      id: 7,
      email: "user@example.com",
    });
  });

  it("forwards only the Better Auth session cookies to the web app session endpoint", async () => {
    respondWith({ user: { id: 7, email: "user@example.com" } });

    await client.getSession({
      headers: {
        cookie: `theme=dark; ${sessionCookie}; other_better-auth.session_token=x; ${secureSessionCookie}`,
      },
    });

    const { url, init } = lastRequest();
    expect(url.href).toBe(`${webAppUrl}/api/auth/get-session`);
    expect(init.headers).toEqual({ cookie: `${sessionCookie}; ${secureSessionCookie}` });
    expect(init.redirect).toBe("manual");
  });

  it("does not call the web app when the request has no session cookie", async () => {
    await expect(client.getSession({ headers: {} })).resolves.toBeNull();
    await expect(client.getSession({ headers: { cookie: "theme=dark" } })).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the web app has no session for the cookie", async () => {
    respondWith(null);

    await expect(client.getSession({ headers: { cookie: sessionCookie } })).resolves.toBeNull();
  });

  it("returns null for a response without a usable user", async () => {
    respondWith({ user: { id: "7", email: "" } });

    await expect(client.getSession({ headers: { cookie: sessionCookie } })).resolves.toBeNull();
  });

  it.each([401, 403, 302, 500])("returns null for a %i response", async (status) => {
    respondWith({ user: { id: 7, email: "user@example.com" } }, status);

    await expect(client.getSession({ headers: { cookie: sessionCookie } })).resolves.toBeNull();
  });

  it("returns null on a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(client.getSession({ headers: { cookie: sessionCookie } })).resolves.toBeNull();
  });

  it("returns null when the web app does not answer within the timeout", async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
      );

      const session = client.getSession({ headers: { cookie: sessionCookie } });
      await jest.advanceTimersByTimeAsync(WEB_SESSION_TIMEOUT_MS);

      await expect(session).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("only calls the configured web origin", async () => {
    respondWith({ user: { id: 7, email: "user@example.com" } });

    await client.getSession({
      headers: { cookie: sessionCookie, host: "evil.example.net", origin: "https://evil.example.net" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequest().url.origin).toBe(webAppUrl);
  });

  it("does not reuse a result across requests", async () => {
    respondWith({ user: { id: 7, email: "user@example.com" } });
    await client.getSession({ headers: { cookie: sessionCookie } });
    respondWith(null);

    await expect(client.getSession({ headers: { cookie: sessionCookie } })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
