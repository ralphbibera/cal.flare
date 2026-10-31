import type { OwnerProfile } from "../domain/profile.ts";
import { canonicalProfile, parseProfile } from "../domain/profile.ts";
import { ErrorWithCode } from "./http.ts";

function unavailable(): never {
  throw new ErrorWithCode("temporarily_unavailable", 503);
}

export function profileInput(input: unknown): OwnerProfile {
  try {
    return parseProfile(input);
  } catch {
    throw new ErrorWithCode("invalid_profile");
  }
}

export function storedProfile(displayName: unknown, bio: unknown): OwnerProfile {
  try {
    return canonicalProfile({ displayName, bio });
  } catch {
    throw new ErrorWithCode("temporarily_unavailable", 503);
  }
}

export async function getProfile(db: D1Database, ownerId: string): Promise<OwnerProfile> {
  const row = await db
    .prepare("SELECT display_name, bio FROM organizer_profile WHERE owner_id=?")
    .bind(ownerId)
    .first<{ display_name: unknown; bio: unknown }>()
    .catch(unavailable);
  return row ? storedProfile(row.display_name, row.bio) : { displayName: null, bio: "" };
}

export async function saveProfile(db: D1Database, ownerId: string, profile: OwnerProfile): Promise<void> {
  await db
    .prepare(`INSERT INTO organizer_profile(owner_id,display_name,bio) VALUES(?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET display_name=excluded.display_name,bio=excluded.bio`)
    .bind(ownerId, profile.displayName, profile.bio)
    .run()
    .catch(unavailable);
}
