import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createContainsInsensitiveMatcher,
  createIlikeMatcher,
  type SqliteIlike,
  toSqliteContainsPrefilter,
  toSqliteIlike,
  toSqliteLowerEquals,
} from "./postgres-ilike";
import { POSTGRES_LOWERCASE_RANGES } from "./postgres-lowercase-ranges";

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

const alphabet = ["a", "A", "i", "I", "İ", "ı", "k", "K", "\u212a", "é", "É", "Å", "\u212b", "ǅ", "Ǆ", "ǆ"];
const specials = ["σ", "Σ", "ς", "😀", "%", "_", "\\"];

function randomText(seed: number) {
  const characters = [...alphabet, ...specials];
  const random = (size: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % size;
  };
  return (length: number) =>
    Array.from({ length: random(length) }, () => characters[random(characters.length)]).join("");
}

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

describe("toSqliteContainsPrefilter", () => {
  it.each([
    ["ADA@example.com", "ada@example.com"],
    ["%top%", "top"],
    ["a%b", "a%b"],
    ["a_b", "a_b"],
    ["a\\_b", "a_b"],
    ["a\\%b", "a_b"],
    ["kit", "__t"],
    ["é", "_"],
  ])("builds %j", (pattern, expected) => {
    expect(toSqliteContainsPrefilter(pattern)).toBe(expected);
  });

  it("keeps every match when SQLite evaluates the prefilter", () => {
    const database = new DatabaseSync(":memory:");
    const like = database.prepare("SELECT ? LIKE ? AS matched");
    const text = randomText(7);
    let matches = 0;
    for (let round = 0; round < 20_000; round++) {
      const pattern = text(5).replace(/\\+$/, "");
      const value = text(7);
      if (!createIlikeMatcher(pattern)(value)) continue;
      matches++;
      const { matched } = like.get(value, `%${toSqliteContainsPrefilter(pattern)}%`) as { matched: number };
      expect({ pattern, value, matched }).toEqual({ pattern, value, matched: 1 });
    }
    expect(matches).toBeGreaterThan(100);
  });
});

describe("toSqliteIlike and toSqliteLowerEquals", () => {
  const database = new DatabaseSync(":memory:");
  const matchesInSqlite = (value: string, { pattern, folds }: SqliteIlike) => {
    const folded = folds.reduce((expression) => `replace(${expression}, ?, ?)`, "?");
    const { matched } = database
      .prepare(`SELECT ${folded} LIKE ? ESCAPE '\\' AS matched`)
      .get(value, ...folds.flat(), pattern) as { matched: number };
    return matched === 1;
  };
  const lowercase = new Map<number, number>();
  for (const [first, last, step, delta] of POSTGRES_LOWERCASE_RANGES) {
    for (let codePoint = first; codePoint <= last; codePoint += step)
      lowercase.set(codePoint, codePoint + delta);
  }
  const postgresLower = (value: string) =>
    String.fromCodePoint(
      ...Array.from(value, (c) => lowercase.get(c.codePointAt(0) as number) ?? (c.codePointAt(0) as number))
    );

  it("escapes LIKE metacharacters PostgreSQL treats as literals", () => {
    expect(toSqliteIlike("%50\\%_")).toEqual({ pattern: "%50\\%_", folds: [] });
    expect(toSqliteIlike("\\\\")).toEqual({ pattern: "\\\\", folds: [] });
  });

  it("folds only the non-ASCII characters PostgreSQL lowers onto a pattern character", () => {
    expect(toSqliteIlike("%ÉKa%")).toEqual({
      pattern: "%éka%",
      folds: [
        ["É", "é"],
        ["\u212a", "k"],
      ],
    });
  });

  it("matches no value when lower() can never produce the text", () => {
    expect(toSqliteLowerEquals("A")).toBeNull();
  });

  it("matches exactly the values PostgreSQL would when SQLite evaluates it", () => {
    const text = randomText(11);
    let matches = 0;
    for (let round = 0; round < 10_000; round++) {
      const pattern = text(5).replace(/\\+$/, "");
      const value = text(7);
      const expected = createIlikeMatcher(pattern)(value);
      if (expected) matches++;
      expect({ pattern, value, matched: matchesInSqlite(value, toSqliteIlike(pattern)) }).toEqual({
        pattern,
        value,
        matched: expected,
      });

      const equals = toSqliteLowerEquals(pattern);
      expect({ pattern, value, equal: equals !== null && matchesInSqlite(value, equals) }).toEqual({
        pattern,
        value,
        equal: postgresLower(value) === pattern,
      });
    }
    expect(matches).toBeGreaterThan(100);
  });
});
