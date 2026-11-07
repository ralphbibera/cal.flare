import { IdentityProvider } from "@calcom/prisma/enums";

/**
 * Maps account provider names to IdentityProvider enum values.
 * Includes aliases (e.g., "saml-idp" -> SAML).
 */
export const ACCOUNT_PROVIDER_TO_IDENTITY_PROVIDER: Record<string, IdentityProvider> = {
  "azure-ad": IdentityProvider.AZUREAD,
  google: IdentityProvider.GOOGLE,
  saml: IdentityProvider.SAML,
  "saml-idp": IdentityProvider.SAML,
  cal: IdentityProvider.CAL,
};

/**
 * Get IdentityProvider enum from account provider name.
 * Returns null for unknown providers so callers can reject the login gracefully.
 */
export const getIdentityProvider = (accountProvider: string): IdentityProvider | null => {
  return ACCOUNT_PROVIDER_TO_IDENTITY_PROVIDER[accountProvider] ?? null;
};
