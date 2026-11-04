import { describe, expect, it } from "vitest";
import { parseAccessCodeScopes } from "./accessScopes";

describe("access code scopes", () => {
  it("preserves token scope values, order and duplicates", () => {
    expect(parseAccessCodeScopes(["READ_PROFILE", "READ_BOOKING", "READ_PROFILE"])).toEqual([
      "READ_PROFILE",
      "READ_BOOKING",
      "READ_PROFILE",
    ]);
  });

  it("reads empty and SQL-null lists as no scopes", () => {
    expect(parseAccessCodeScopes([])).toEqual([]);
    expect(parseAccessCodeScopes(null)).toEqual([]);
  });

  it.each([
    undefined,
    {},
    "READ_PROFILE",
    '["READ_PROFILE"]',
    [null],
    [["READ_PROFILE"]],
    [1],
    ["WRITE_BOOKING"],
  ])("rejects malformed stored scopes %j", (value) => {
    expect(() => parseAccessCodeScopes(value)).toThrow();
  });
});
