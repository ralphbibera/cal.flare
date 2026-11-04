import { AccessScope } from "@calcom/prisma/enums";
import { z } from "zod";

const accessScopesSchema = z.array(z.nativeEnum(AccessScope));

export function parseAccessCodeScopes(value: unknown): AccessScope[] {
  return accessScopesSchema.parse(value === null ? [] : value);
}
