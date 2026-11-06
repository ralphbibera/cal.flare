-- Partial unique indexes from the PostgreSQL history at e8afecd (20230531133843_organizations). They live
-- only in raw migration SQL, not schema.prisma, so the generated domain tables omitted them. Without them a
-- NULL parentId or organizationId lets two top-level teams share a slug, or two org-less users a username.

CREATE UNIQUE INDEX "Team_slug_parentId_key_null" ON "Team"("slug", ("parentId" IS NULL)) WHERE "parentId" IS NULL;

CREATE UNIQUE INDEX "users_username_organizationId_key_null" ON "users"("username", ("organizationId" IS NULL)) WHERE "organizationId" IS NULL;
