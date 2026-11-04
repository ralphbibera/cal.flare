import { z } from "zod";

const redirectUrisSchema = z.array(z.string());

export function parseOAuthRedirectUris(value: unknown): string[] {
  return redirectUrisSchema.parse(value === null ? [] : value);
}
