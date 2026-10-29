const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_+-.']*)[A-Z0-9_+'-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

export function parseGuests(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const emails: unknown[] = [...value];
  if (!emails.every((email) => typeof email === "string")) return null;
  if (emails.every((email) => email === "")) return undefined;
  const guests: string[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    if (email.length > 254 || email.match(emailRegex)?.[0] !== email) return null;
    const normalized = email.toLowerCase();
    if (seen.has(normalized)) return null;
    seen.add(normalized);
    guests.push(normalized);
  }
  return Object.freeze(guests);
}
