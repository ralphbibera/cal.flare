import { POSTGRES_LOWERCASE_RANGES } from "./postgres-lowercase-ranges";

const lowercaseByCodePoint = new Map<number, number>();
for (const [first, last, step, delta] of POSTGRES_LOWERCASE_RANGES) {
  for (let codePoint = first; codePoint <= last; codePoint += step) {
    lowercaseByCodePoint.set(codePoint, codePoint + delta);
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
