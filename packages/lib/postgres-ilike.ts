import { type KeysetPage as NumericKeysetPage, scanKeysetBatches } from "./keyset-scan";
import { POSTGRES_LOWERCASE_RANGES } from "./postgres-lowercase-ranges";

const MAX_ASCII = 0x7f;
const lowercaseByCodePoint = new Map<number, number>();
const asciiFoldedFromNonAscii = new Set<number>();
for (const [first, last, step, delta] of POSTGRES_LOWERCASE_RANGES) {
  for (let codePoint = first; codePoint <= last; codePoint += step) {
    const lowercase = codePoint + delta;
    lowercaseByCodePoint.set(codePoint, lowercase);
    if (codePoint > MAX_ASCII && lowercase <= MAX_ASCII) asciiFoldedFromNonAscii.add(lowercase);
  }
}

const ANY_ONE = -1;
const ANY_MANY = -2;
const BACKSLASH = 0x5c;
const PERCENT = 0x25;
const UNDERSCORE = 0x5f;

function toLowercaseCodePoints(value: string): number[] {
  const codePoints: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    codePoints.push(lowercaseByCodePoint.get(codePoint) ?? codePoint);
  }
  return codePoints;
}

function compilePattern(pattern: string): number[] {
  const source = toLowercaseCodePoints(pattern);
  const tokens: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const codePoint = source[index];
    if (codePoint === PERCENT) {
      if (tokens.at(-1) !== ANY_MANY) tokens.push(ANY_MANY);
    } else if (codePoint === UNDERSCORE) {
      tokens.push(ANY_ONE);
    } else if (codePoint === BACKSLASH) {
      index++;
      if (index === source.length) {
        throw new Error(`LIKE pattern must not end with escape character: ${pattern}`);
      }
      tokens.push(source[index]);
    } else {
      tokens.push(codePoint);
    }
  }
  return tokens;
}

// Iterative rather than a RegExp: searches are user input, and `%a%a%a...` must not backtrack exponentially.
function matchesTokens(tokens: number[], value: number[]): boolean {
  let tokenIndex = 0;
  let valueIndex = 0;
  let resumeToken = -1;
  let resumeValue = 0;
  while (valueIndex < value.length) {
    const token = tokens[tokenIndex];
    if (token === ANY_MANY) {
      resumeToken = ++tokenIndex;
      resumeValue = valueIndex;
    } else if (tokenIndex < tokens.length && (token === ANY_ONE || token === value[valueIndex])) {
      tokenIndex++;
      valueIndex++;
    } else if (resumeToken !== -1) {
      tokenIndex = resumeToken;
      valueIndex = ++resumeValue;
    } else {
      return false;
    }
  }
  while (tokens[tokenIndex] === ANY_MANY) tokenIndex++;
  return tokenIndex === tokens.length;
}

type IlikeMatcher = (value: string | null | undefined) => boolean;

/**
 * Evaluates a pattern as PostgreSQL ILIKE does, for the `mode: "insensitive"` filters SQLite cannot express:
 * its LIKE and lower() only fold ASCII.
 */
export function createIlikeMatcher(pattern: string): IlikeMatcher {
  const tokens = compilePattern(pattern);
  return (value) =>
    value !== null && value !== undefined && matchesTokens(tokens, toLowercaseCodePoints(value));
}

/** Prisma interpolates `contains` into the pattern unescaped, so `%` and `_` in a search stay wildcards. */
export function createContainsInsensitiveMatcher(search: string): IlikeMatcher {
  return createIlikeMatcher(`%${search}%`);
}

/**
 * Builds a value for Prisma's SQLite `contains` that keeps every row the pattern could match, so lookups over
 * large tables can narrow candidates in SQL and confirm them with createIlikeMatcher. SQLite's LIKE folds only
 * ASCII, so any character it could not compare the way PostgreSQL does becomes a single-character wildcard.
 */
export function toSqliteContainsPrefilter(pattern: string): string {
  let prefilter = "";
  for (const token of compilePattern(pattern)) {
    if (token === ANY_MANY) prefilter += "%";
    else if (
      token === ANY_ONE ||
      token === PERCENT ||
      token === UNDERSCORE ||
      token > MAX_ASCII ||
      asciiFoldedFromNonAscii.has(token)
    ) {
      prefilter += "_";
    } else prefilter += String.fromCodePoint(token);
  }
  return prefilter.replace(/^%+|%+$/g, "");
}

const SEARCH_SCAN_BATCH_SIZE = 100;

export type KeysetPage = NumericKeysetPage<number>;

/**
 * Applies a `contains` + `mode: "insensitive"` search in memory, before the page is cut, walking the caller's
 * already-scoped rows in key order so cursors stay stable. Only use it on a bounded scope, since every
 * candidate row is read. Returns up to limit + 1 rows for the hasMore check, or every match without a limit.
 */
export async function findSearchedRows<Row>({
  search,
  cursor,
  limit,
  fetchRows,
  getKey,
  getSearchValues,
}: {
  search?: string;
  cursor?: number;
  limit?: number;
  fetchRows: (page: KeysetPage) => Promise<Row[]>;
  getKey: (row: Row) => number;
  getSearchValues: (row: Row) => Array<string | null | undefined>;
}): Promise<Row[]> {
  if (!search && limit !== undefined) return fetchRows({ after: cursor, take: limit + 1 });

  const matches = search ? createContainsInsensitiveMatcher(search) : () => true;
  const take = Math.max((limit ?? 0) + 1, SEARCH_SCAN_BATCH_SIZE);
  const matched: Row[] = [];
  for await (const rows of scanKeysetBatches({ fetchRows, getKey, after: cursor, take })) {
    for (const row of rows) {
      if (getSearchValues(row).some((value) => matches(value))) matched.push(row);
    }
    if (limit !== undefined && matched.length > limit) break;
  }
  return limit === undefined ? matched : matched.slice(0, limit + 1);
}
