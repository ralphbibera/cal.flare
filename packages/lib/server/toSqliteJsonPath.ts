export function toSqliteJsonPath(segments: readonly string[]): string {
  return `$${segments.map((segment) => `.${JSON.stringify(segment)}`).join("")}`;
}
