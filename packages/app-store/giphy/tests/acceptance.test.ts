import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import add from "../api/add";
import get from "../api/get";
import search from "../api/search";

const API_KEY = "giphy-api-key";

const { prisma, getAppKeys } = vi.hoisted(() => ({
  prisma: {
    credential: { findFirst: vi.fn(), create: vi.fn() },
    user: { findFirst: vi.fn() },
  },
  getAppKeys: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ default: prisma, prisma }));
vi.mock("../../_utils/getAppKeysFromSlug", () => ({ default: getAppKeys }));
vi.mock("../../_utils/throwIfNotHaveAdminAccessToTeam", () => ({
  throwIfNotHaveAdminAccessToTeam: vi.fn(),
}));

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

const createResponse = (): MockResponse => {
  const res: MockResponse = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "POST",
    query: {},
    body: {},
    session: { user: { id: 1 } },
    ...overrides,
  }) as unknown as NextApiRequest;

const buildResponse = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetAllMocks();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  getAppKeys.mockResolvedValue({ api_key: API_KEY });
  prisma.credential.create.mockResolvedValue({ id: 1 });
  prisma.credential.findFirst.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue({ id: 1, locale: "fr" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Giphy install", () => {
  it("installs a per-user credential and returns the catalog path", async () => {
    const res = createResponse();

    await add(buildRequest(), res as unknown as NextApiResponse);

    expect(prisma.credential.findFirst).toHaveBeenCalledWith({
      where: { type: "giphy_other", userId: 1 },
    });
    expect(prisma.credential.create).toHaveBeenCalledWith({
      data: { type: "giphy_other", key: {}, userId: 1, appId: "giphy" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ url: "/apps/installed/other?hl=giphy" });
  });

  it("rejects an unauthenticated install", async () => {
    const res = createResponse();

    await add(buildRequest({ session: undefined }), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("keeps the baseline already-installed mapping to 500", async () => {
    prisma.credential.findFirst.mockResolvedValue({ id: 1 });
    const res = createResponse();

    await add(buildRequest(), res as unknown as NextApiResponse);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Already installed" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("Giphy search", () => {
  it("searches with the stored key, user locale and one-result paging", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        data: [{ images: { fixed_height_downsampled: { url: "https://media.giphy.com/cat.gif" } } }],
        pagination: { total_count: 5 },
      })
    );
    const res = createResponse();

    await search(buildRequest({ body: { keyword: "cats", offset: 0 } }), res as unknown as NextApiResponse);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      api_key: API_KEY,
      q: "cats",
      limit: "1",
      offset: "0",
      rating: "g",
      lang: "fr",
    });
    expect(res.json).toHaveBeenCalledWith({
      image: "https://media.giphy.com/cat.gif",
      nextOffset: 1,
    });
  });

  it("rotates the offset back to zero after the last result", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        data: [{ images: { fixed_height_downsampled: { url: "https://media.giphy.com/last.gif" } } }],
        pagination: { total_count: 1 },
      })
    );
    const res = createResponse();

    await search(buildRequest({ body: { keyword: "cats", offset: 0 } }), res as unknown as NextApiResponse);

    expect(res.json).toHaveBeenCalledWith({ image: "https://media.giphy.com/last.gif", nextOffset: 0 });
  });

  it("rejects a missing API key and invalid search input", async () => {
    getAppKeys.mockResolvedValue({});
    const missingKey = createResponse();
    await search(
      buildRequest({ body: { keyword: "cats", offset: 0 } }),
      missingKey as unknown as NextApiResponse
    );
    expect(missingKey.status).toHaveBeenCalledWith(400);
    expect(missingKey.json).toHaveBeenCalledWith({ message: "Missing Giphy api_key" });

    getAppKeys.mockResolvedValue({ api_key: API_KEY });
    const invalid = createResponse();
    await search(buildRequest({ body: { keyword: "cats" } }), invalid as unknown as NextApiResponse);
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Giphy lookup by URL", () => {
  it("extracts the gif id and returns its downsampled image", async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        data: { images: { fixed_height_downsampled: { url: "https://media.giphy.com/cat.gif" } } },
      })
    );
    const res = createResponse();

    await get(
      buildRequest({ body: { url: "https://media.giphy.com/media/abc123/giphy.gif?cid=1" } }),
      res as unknown as NextApiResponse
    );

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ api_key: API_KEY });
    expect(url).toContain("/v1/gifs/abc123");
    expect(res.json).toHaveBeenCalledWith({ image: "https://media.giphy.com/cat.gif" });
  });

  it("rejects a non-Giphy URL", async () => {
    const invalid = createResponse();
    await get(
      buildRequest({ body: { url: "https://example.com/cat.gif" } }),
      invalid as unknown as NextApiResponse
    );
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
