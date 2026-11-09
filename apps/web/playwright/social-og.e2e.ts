import { expect, test } from "@playwright/test";

const PNG_MAGIC: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CACHE_CONTROL =
  "public, max-age=31536000, immutable, s-maxage=31536000, stale-while-revalidate=31536000";

const images = [
  {
    type: "meeting",
    params: { type: "meeting", title: "Team sync", meetingProfileName: "Alice" },
    missing: {
      error: "Invalid parameters for meeting image",
      message: "Required parameters: title, meetingProfileName. Optional: names, usernames, meetingImage",
    },
  },
  {
    type: "app",
    params: {
      type: "app",
      name: "Zoom",
      description: "Video",
      slug: "zoomvideo",
      logoUrl: "/app-store/zoomvideo/icon.svg",
    },
    missing: {
      error: "Invalid parameters for app image",
      message: "Required parameters: name, description, slug",
    },
  },
  {
    type: "generic",
    params: { type: "generic", title: "Test", description: "Hello" },
    missing: {
      error: "Invalid parameters for generic image",
      message: "Required parameters: title, description",
    },
  },
] as const;

for (const { type, params, missing } of images) {
  test(`renders the ${type} PNG with upstream headers`, async ({ request }) => {
    const response = await request.get("/api/social/og/image", { params });
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers["content-type"]).toBe("image/png");
    expect(headers["cache-control"]).toBe(CACHE_CONTROL);
    expect(headers.etag).toMatch(/^"[0-9a-f]{8}"$/);

    const png = await response.body();
    expect(png.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.length).toBeGreaterThan(50_000);
    expect(png.length).toBeLessThan(5_000_000);

    const repeat = await request.get("/api/social/og/image", { params });
    expect(repeat.status()).toBe(200);
    expect(repeat.headers().etag).toBe(headers.etag);
  });

  test(`rejects ${type} requests missing upstream's required parameters`, async ({ request }) => {
    const response = await request.get("/api/social/og/image", { params: { type } });
    expect(response.status()).toBe(400);
    expect(response.headers()["content-type"]).toBe("application/json");
    expect(await response.json()).toEqual(missing);
  });
}

test("rejects an unknown image type with upstream's 404", async ({ request }) => {
  const response = await request.get("/api/social/og/image", { params: { type: "invalid" } });
  expect(response.status()).toBe(404);
  expect(await response.text()).toBe("Wrong image type");
});
