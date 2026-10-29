export function parseRescheduleReason(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (reason.length > 1000) return null;
  return reason || undefined;
}
