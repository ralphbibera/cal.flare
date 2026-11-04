import type { SSRConfig } from "@calcom/i18n/ssr";
import { getServerTranslations } from "@calcom/i18n/ssr";
import type { I18nInputSchema } from "./i18n.schema";

type I18nOptions = {
  input: I18nInputSchema;
};

export const i18nHandler = async ({ input }: I18nOptions): Promise<{ i18n: SSRConfig; locale: string }> => {
  const { locale } = input;
  const i18n = await getServerTranslations(locale, ["common", "vital"]);

  return {
    i18n,
    locale,
  };
};

export default i18nHandler;
