import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addPing from "../ping/api/add";
import pingConfig from "../ping/config.json";
import addRiverside from "../riverside/api/add";
import riversideConfig from "../riverside/config.json";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    credential: { create: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));

vi.mock("@calcom/lib/logger", () => {
  const getSubLogger = () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    getSubLogger,
  });
  return { default: { ...getSubLogger(), getSubLogger } };
});

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
    writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "GET",
    query: {},
    url: "/api/integrations/ping/add",
    session: { user: { id: 7, username: "jane", email: "jane@example.com" } },
    ...overrides,
  }) as unknown as NextApiRequest;

type GetLinkApp = {
  name: string;
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
  config: {
    slug: string;
    type: string;
    variant: string;
    categories: string[];
    appData: { location: { linkType: string; urlRegExp: string } };
  };
  acceptedUrl: string;
  rejectedUrl: string;
};

const GET_LINK_APPS: GetLinkApp[] = [
  {
    name: "Ping.gg",
    handler: addPing,
    config: pingConfig,
    acceptedUrl: "https://www.ping.gg/call/theo",
    rejectedUrl: "https://www.ping.gg.evil.example/call/theo",
  },
  {
    name: "Riverside",
    handler: addRiverside,
    config: riversideConfig,
    acceptedUrl: "https://riverside.fm/studio/abc",
    rejectedUrl: "https://riverside.fm.evil.example/studio/abc",
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 5 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(GET_LINK_APPS)("$name link install", ({ handler, config, acceptedUrl, rejectedUrl }) => {
  it("declares a static conferencing link with a GET install handler", () => {
    expect(config).toMatchObject({
      variant: "conferencing",
      categories: ["conferencing"],
      appData: { location: { linkType: "static" } },
    });
  });

  it("accepts its meeting links and rejects lookalike domains", () => {
    const urlPattern = new RegExp(config.appData.location.urlRegExp);

    expect(urlPattern.test(acceptedUrl)).toBe(true);
    expect(urlPattern.test(rejectedUrl)).toBe(false);
  });

  it("installs the link app with an empty credential and redirects to the installed page", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = createResponse();

    await handler(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { appId: config.slug, userId: 7 },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: config.type, key: {}, userId: 7, appId: config.slug },
    });
    expect(res.json).toHaveBeenCalledWith({ url: `/apps/installed/conferencing?hl=${config.slug}` });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the requested returnTo path", async () => {
    const res = createResponse();

    await handler(
      buildRequest({ query: { returnTo: "/apps/installed/video" } }),
      res as unknown as NextApiResponse
    );

    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/video" });
  });

  it("rejects a second installation with the baseline 422 response", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 5 });
    const res = createResponse();

    await handler(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Already installed" }));
  });

  it("rejects an unauthenticated install with 401", async () => {
    const res = createResponse();

    await handler(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Unauthorized" }));
  });

  it("only accepts GET", async () => {
    const res = createResponse();

    await handler(
      buildRequest({ method: "POST", session: { user: { id: 7 } } }),
      res as unknown as NextApiResponse
    );

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ message: "Method Not Allowed (Allow: GET)" });
  });
});
