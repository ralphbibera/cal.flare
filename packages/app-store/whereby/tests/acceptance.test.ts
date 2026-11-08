import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import addWhereby from "../api/add";
import appConfig from "../config.json";
import * as wherebyApp from "../index";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    credential: { findFirst: vi.fn(), create: vi.fn() },
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
    url: "/api/integrations/whereby/add",
    session: { user: { id: 7 } },
    ...overrides,
  }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.resetAllMocks();
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.credential.create.mockResolvedValue({ id: 3 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Whereby link install", () => {
  it("installs the static link app with an empty credential key", async () => {
    const res = createResponse();

    await addWhereby(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { appId: "whereby", userId: 7 },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "whereby_video",
        appId: "whereby",
        userId: 7,
        key: {},
      }),
    });
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/conferencing?hl=whereby" });
  });

  it("returns the requested returnTo path", async () => {
    const res = createResponse();

    await addWhereby(
      buildRequest({ query: { returnTo: "/apps/installed/video" } }),
      res as unknown as NextApiResponse
    );

    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/video" });
  });

  it("rejects a second installation with the baseline 422 response", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 3 });
    const res = createResponse();

    await addWhereby(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Already installed" }));
  });

  it("rejects an unauthenticated install with 401", async () => {
    const res = createResponse();

    await addWhereby(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(prisma.credential.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Unauthorized" }));
  });
});

describe("Whereby metadata and link contract", () => {
  it("stays a static link app with no video API adapter", () => {
    expect(appConfig).toMatchObject({
      slug: "whereby",
      type: "whereby_video",
      variant: "conferencing",
      isAuth: false,
    });
    expect(appConfig.appData.location).toMatchObject({
      linkType: "static",
      type: "integrations:whereby_video",
      label: "Whereby Video",
    });
    expect(Object.keys(wherebyApp)).toEqual(["api"]);
  });

  it("accepts Whereby meeting URLs and rejects lookalike domains", () => {
    const urlPattern = new RegExp(appConfig.appData.location.urlRegExp);

    expect(urlPattern.test("https://www.whereby.com/cal")).toBe(true);
    expect(urlPattern.test("https://whereby.com/team/room")).toBe(true);
    expect(urlPattern.test("https://example.com/cal")).toBe(false);
    expect(urlPattern.test("https://www.whereby.com.evil.example/cal")).toBe(false);
    expect(urlPattern.test("https://notwhereby.com/cal")).toBe(false);
  });

  it("installs without calling a Whereby API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = createResponse();

    await addWhereby(buildRequest(), res as unknown as NextApiResponse);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
