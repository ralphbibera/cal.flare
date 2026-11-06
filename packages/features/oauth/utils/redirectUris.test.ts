import { describe, expect, it } from "vitest";
import { parseOAuthRedirectUris } from "./redirectUris";

describe("OAuth client redirect URIs", () => {
  it("preserves exact strings, order and duplicates without URL policy", () => {
    const uris = ["https://EXAMPLE.com/callback/", "*.example.com", "", "redirect-uri", "*.example.com"];
    expect(parseOAuthRedirectUris(uris)).toEqual(uris);
  });

  it("reads empty and SQL-null lists as no redirects", () => {
    expect(parseOAuthRedirectUris([])).toEqual([]);
    expect(parseOAuthRedirectUris(null)).toEqual([]);
  });

  it.each([
    undefined,
    {},
    "https://example.com",
    '["https://example.com"]',
    [null],
    [["redirect"]],
    [1],
  ])("rejects malformed stored redirect lists %j", (value) => {
    expect(() => parseOAuthRedirectUris(value)).toThrow();
  });
});
