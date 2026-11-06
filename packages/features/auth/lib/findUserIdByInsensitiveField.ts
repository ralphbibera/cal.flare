import { createIlikeMatcher, toSqliteContainsPrefilter } from "@calcom/lib/postgres-ilike";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";

const CANDIDATE_BATCH_SIZE = 200;

// Sign-in compares provider identities with PostgreSQL's `equals` + `mode: "insensitive"`, which SQLite cannot
// evaluate. The prefilter keeps these lookups from reading every user into the Worker.
export async function findUserIdByInsensitiveField({
  where,
  field,
  value,
}: {
  where?: Prisma.UserWhereInput;
  field: "email" | "identityProviderId";
  value: string;
}): Promise<number | null> {
  const matches = createIlikeMatcher(value);
  const contains = toSqliteContainsPrefilter(value);
  let after: number | undefined;
  while (true) {
    const candidates = await prisma.user.findMany({
      where: { ...where, [field]: { contains }, ...(after && { id: { gt: after } }) },
      select: { id: true, email: true, identityProviderId: true },
      orderBy: { id: "asc" },
      take: CANDIDATE_BATCH_SIZE,
    });
    const match = candidates.find((candidate) => matches(candidate[field]));
    if (match) return match.id;
    if (candidates.length < CANDIDATE_BATCH_SIZE) return null;
    after = candidates[candidates.length - 1].id;
  }
}
