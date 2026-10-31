import { z } from "zod";

const PROFILE_NAME_LIMIT = 100;
const PROFILE_BIO_LIMIT = 2000;

const profileSchema = z
  .object({
    displayName: z.string().max(PROFILE_NAME_LIMIT).nullable(),
    bio: z.string().max(PROFILE_BIO_LIMIT),
  })
  .strict();

type OwnerProfile = z.infer<typeof profileSchema>;

function parseProfile(input: unknown): OwnerProfile {
  const profile = profileSchema
    .extend({ displayName: z.string().trim().max(PROFILE_NAME_LIMIT).nullable() })
    .parse(input);
  return { displayName: profile.displayName || null, bio: profile.bio };
}

function canonicalProfile(input: unknown): OwnerProfile {
  const profile = profileSchema.parse(input);
  const canonical = parseProfile(profile);
  if (canonical.displayName !== profile.displayName) throw new Error("Invalid stored profile");
  return canonical;
}

export { canonicalProfile, parseProfile, PROFILE_BIO_LIMIT, PROFILE_NAME_LIMIT, type OwnerProfile };
