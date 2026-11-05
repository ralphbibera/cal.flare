import { getD1Database } from "@calcom/prisma/d1";
import { getAuthRequestEnvironment } from "../../request-context";

export async function matchesRequest(secret: string, marker: string): Promise<boolean> {
  const value = await getD1Database().prepare("SELECT value FROM context_marker").first<string>("value");
  return getAuthRequestEnvironment().NEXTAUTH_SECRET === secret && value === marker;
}

export function hasRequestEnvironment(): boolean {
  try {
    getAuthRequestEnvironment();
    return true;
  } catch {
    return false;
  }
}
