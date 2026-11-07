declare module "@calcom/i18n/next-i18next.config" {
  export const i18n: {
    locales: string[];
    defaultLocale: string;
  };
  const config: { i18n: typeof i18n; fallbackLng: Record<string, string[]> };
  export default config;
}
