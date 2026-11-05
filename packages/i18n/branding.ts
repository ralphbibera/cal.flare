// biome-ignore lint/correctness/noProcessGlobal: Vite replaces public process.env expressions during browser bundling.
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Cal.flare";

export function brandText(text: string): string {
  // Deployment branding must not rewrite upstream links or contact addresses.
  return text.replace(
    /https?:\/\/[^\s"'<>]+|cal\.diy(?:\.[a-z]+|\/)[^\s"'<>]*|[\w.+-]+@[\w.-]+|cal\.diy/gi,
    (match) => (match.toLowerCase() === "cal.diy" ? APP_NAME : match)
  );
}
import type { TranslationDictionary } from "./resources";

export function brandTranslations(dictionary: Readonly<TranslationDictionary>): TranslationDictionary {
  return Object.fromEntries(
    Object.entries(dictionary).map(([key, value]) => [
      key,
      typeof value === "string" ? brandText(value) : brandTranslations(value),
    ])
  );
}
