// biome-ignore-all lint/style/noRestrictedImports: the Worker shim re-exports the source calendar errors without the app-store graph
// The Worker bundles from source, so the prebuilt platform-libraries barrel would supply a second
// copy of these classes and break the calendar filter's @Catch identity. Worker builds alias that
// barrel here instead of loading the app-store graph.
export {
  CalendarAppDelegationCredentialClientIdNotAuthorizedError,
  CalendarAppDelegationCredentialConfigurationError,
  CalendarAppDelegationCredentialError,
  CalendarAppDelegationCredentialInvalidGrantError,
  CalendarAppDelegationCredentialNotSetupError,
  CalendarAppError,
} from "@calcom/lib/CalendarAppError";
