import type { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import type { AppCategories } from "@calcom/prisma/enums";
import { z } from "zod";

const localAppSchema = z.object({
  slug: z.string(),
  keys: z
    .string()
    .nullable()
    .transform((value): Prisma.JsonValue => (value === null ? null : JSON.parse(value))),
  enabled: z.union([z.literal(0), z.literal(1)]).transform(Boolean),
  dirName: z.string(),
});

export class D1AppRepository {
  static async findLocalByCategory(category: string) {
    const { results } = await getD1Database()
      .prepare(`SELECT a."slug", a."keys", a."enabled", a."dirName"
        FROM "App" a
        WHERE EXISTS (SELECT 1 FROM json_each(a."categories") WHERE value = ?)`)
      .bind(category)
      .all();
    return localAppSchema.array().parse(results);
  }

  static async findEnabledSlugsByCategory(category: AppCategories) {
    const { results } = await getD1Database()
      .prepare(`SELECT a."slug" FROM "App" a
        WHERE a."enabled" = 1
          AND EXISTS (SELECT 1 FROM json_each(a."categories") WHERE value = ?)`)
      .bind(category)
      .all();
    return z.object({ slug: z.string() }).array().parse(results);
  }
}
