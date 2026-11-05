import { parseAppCategories } from "@calcom/lib/apps/parseAppCategories";
import type { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { z } from "zod";

const paymentCredentialSchema = z.object({
  key: z.string().transform((value): Prisma.JsonValue => JSON.parse(value)),
  appId: z.string(),
  categories: z
    .string()
    .transform((value) => parseAppCategories({ categories: JSON.parse(value) }).categories),
  dirName: z.string(),
});

export class D1PaymentCredentialRepository {
  static async findForBooking({ credentialId, userId }: { credentialId?: number | null; userId: number }) {
    const { results } = await getD1Database()
      .prepare(`SELECT c."key", c."appId", a."categories", a."dirName"
        FROM "Credential" c JOIN "App" a ON a."slug" = c."appId"
        WHERE ${credentialId ? 'c."id"' : 'c."userId"'} = ?
          AND EXISTS (SELECT 1 FROM json_each(a."categories") WHERE value = 'payment')`)
      .bind(credentialId || userId)
      .all();
    return paymentCredentialSchema
      .array()
      .parse(results)
      .map(({ key, appId, categories, dirName }) => ({
        key,
        appId,
        app: { categories, dirName },
      }));
  }
}
