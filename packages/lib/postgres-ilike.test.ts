import { describe, expect, it } from "vitest";
import { createContainsInsensitiveMatcher, createIlikeMatcher } from "./postgres-ilike";

const values = [
  "I",
  "i",
  "İ",
  "ı",
  "i̇",
  "Σ",
  "σ",
  "ς",
  "ΟΣ",
  "É",
  "é",
  "É",
  "é",
  "a%b",
  "axb",
  "a_b",
  "a\\b",
  "a\nb",
  "😀",
  "𐐀",
  "𐐨",
  "",
  null,
];

function matchingIds(matches: (value: string | null) => boolean) {
  return values.flatMap((value, index) => (matches(value) ? [index + 1] : []));
}

const allNonNull = values.slice(0, -1).map((_, index) => index + 1);

describe("PostgreSQL ILIKE parity", () => {
  // Expected ids were captured from Prisma 6.16.3 `contains` + `mode: "insensitive"` on postgres:18.
  it.each<[string, number[]]>([
    ["I", [1, 2, 3, 5]],
    ["i", [1, 2, 3, 5]],
    ["İ", [1, 2, 3, 5]],
    ["ı", [4]],
    ["i̇", [5]],
    ["Σ", [6, 7, 9]],
    ["σ", [6, 7, 9]],
    ["ς", [8]],
    ["ΟΣ", [9]],
    ["É", [10, 11]],
    ["é", [10, 11]],
    ["É", [12, 13]],
    ["é", [12, 13]],
    ["%", allNonNull],
    ["_", allNonNull.filter((id) => id !== 22)],
    ["\\", []],
    ["\\%", [14]],
    ["\\_", [16]],
    ["a%b", [14, 15, 16, 17, 18]],
    ["a_b", [14, 15, 16, 17, 18]],
    ["a\\b", []],
    ["a\nb", [18]],
    ["😀", [19]],
    ["𐐀", [20, 21]],
    ["𐐨", [20, 21]],
    ["", allNonNull],
  ])("contains %j", (search, expected) => {
    expect(matchingIds(createContainsInsensitiveMatcher(search))).toEqual(expected);
  });

  it("keeps characters unfolded where glibc differs from newer JavaScript Unicode data", () => {
    expect(createIlikeMatcher("\u{16EBB}")("\u{16EA0}")).toBe(false);
    expect("\u{16EA0}".toLowerCase()).toBe("\u{16EBB}");
  });

  it("rejects a pattern ending in an escape as PostgreSQL does", () => {
    expect(() => createIlikeMatcher("%a\\")).toThrow("LIKE pattern must not end with escape character");
  });

  it("does not backtrack exponentially on repeated wildcards", () => {
    const matches = createIlikeMatcher(`${"%a".repeat(50)}%b`);
    expect(matches("a".repeat(5_000))).toBe(false);
  });
});
