import { z } from "zod";

export type OAuthAccount = {
  provider: string;
  providerAccountId: string;
  type: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  session_state?: string;
};

export type OAuthUser = {
  id: string | number;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
};

// Providers disagree on shape: Google sends a boolean `email_verified`, Azure AD sends `xms_edov`
// as a boolean for work/school accounts and as "1" for personal ones. A malformed claim reads as absent.
export const oauthProfileSchema = z.object({
  email_verified: z.boolean().optional().catch(undefined),
  xms_edov: z.union([z.boolean(), z.string(), z.number()]).optional().catch(undefined),
});
export type OAuthProfile = z.infer<typeof oauthProfileSchema>;

export type OAuthSignInDecision =
  | { kind: "allow"; userId: number }
  | { kind: "redirect"; to: string }
  | { kind: "deny" };

// The auth core depends on this port only. The implementation pulls in the calendar clients, which the
// Worker program must not type-check, so the Pages handler supplies it.
export interface OAuthSignInPort {
  signIn(params: {
    user: OAuthUser;
    account: OAuthAccount;
    profile: OAuthProfile;
  }): Promise<OAuthSignInDecision>;
  completeSignIn(params: { userId: number; user: OAuthUser; account: OAuthAccount }): Promise<void>;
}
