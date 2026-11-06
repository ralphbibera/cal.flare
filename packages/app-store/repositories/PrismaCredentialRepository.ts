import { buildNonDelegationCredentials } from "@calcom/lib/delegationCredential";
import type { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import type { AppCategories } from "@calcom/prisma/enums";
import { z } from "zod";

export type CredentialOwner = { userId: number } | { teamIds: number[] };

const credentialColumns = `c."id", c."appId", c."type", c."userId", c."teamId", c."key", c."encryptedKey",
  c."invalid", c."delegationCredentialId", u."email" AS "userEmail"`;
const credentialSchema = z.object({
  id: z.number(),
  appId: z.string().nullable(),
  type: z.string(),
  userId: z.number().nullable(),
  teamId: z.number().nullable(),
  key: z.string().transform((value): Prisma.JsonValue => JSON.parse(value)),
  encryptedKey: z.string().nullable(),
  invalid: z
    .union([z.literal(0), z.literal(1)])
    .nullable()
    .transform((value) => (value === null ? null : Boolean(value))),
  delegationCredentialId: z.string().nullable(),
  userEmail: z.string().nullable(),
});

function credentialWithUser<T extends z.infer<typeof credentialSchema>>(row: T) {
  const { userEmail, ...credential } = row;
  return { ...credential, user: userEmail === null ? null : { email: userEmail } };
}

export class PrismaCredentialRepository {
  async findNonDelegationCredentialsByAppCategories({
    owner,
    appCategories,
  }: {
    owner: CredentialOwner;
    appCategories: AppCategories[];
  }) {
    const { results } = await getD1Database()
      .prepare(`SELECT ${credentialColumns}, CASE WHEN t."id" IS NULL THEN NULL ELSE json_object('name', t."name") END AS "team"
      FROM "Credential" c JOIN "App" a ON a."slug" = c."appId"
      LEFT JOIN "users" u ON u."id" = c."userId" LEFT JOIN "Team" t ON t."id" = c."teamId"
      WHERE ${"userId" in owner ? 'c."userId" = ?' : 'c."teamId" IN (SELECT value FROM json_each(?))'}
        AND EXISTS (SELECT 1 FROM json_each(a."categories") category
          WHERE category.value IN (SELECT value FROM json_each(?)))`)
      .bind("userId" in owner ? owner.userId : JSON.stringify(owner.teamIds), JSON.stringify(appCategories))
      .all();
    const credentials = credentialSchema
      .extend({
        team: z
          .string()
          .nullable()
          .transform((value) =>
            value === null ? null : z.object({ name: z.string() }).parse(JSON.parse(value))
          ),
      })
      .array()
      .parse(results)
      .map((row) => credentialWithUser(row));
    return buildNonDelegationCredentials(credentials);
  }

  async findEnabledCalendarCredentialsForUser(userId: number) {
    const { results } = await getD1Database()
      .prepare(`SELECT ${credentialColumns},
      (SELECT json_group_array(json_object('id', s."id")) FROM "SelectedCalendar" s
        WHERE s."credentialId" = c."id") AS "selectedCalendars"
      FROM "Credential" c JOIN "App" a ON a."slug" = c."appId"
      LEFT JOIN "users" u ON u."id" = c."userId"
      WHERE c."userId" = ? AND a."enabled" = 1
        AND EXISTS (SELECT 1 FROM json_each(a."categories") WHERE value = 'calendar')`)
      .bind(userId)
      .all();
    return credentialSchema
      .extend({
        selectedCalendars: z
          .string()
          .transform((value) => z.object({ id: z.string() }).array().parse(JSON.parse(value))),
      })
      .array()
      .parse(results)
      .map((row) => credentialWithUser(row));
  }
}
