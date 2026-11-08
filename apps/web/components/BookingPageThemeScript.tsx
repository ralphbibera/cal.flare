import type { JSX } from "react";

const SUPPORTED_THEMES = new Set(["light", "dark"]);

type BookingPageThemeScriptProps = {
  theme: string | null | undefined;
  themeBasis: string | null | undefined;
  nonce?: string;
  isEmbedMode?: boolean;
};

/**
 * Writes the organizer's booking theme into the document while the server HTML is parsed.
 *
 * next-themes only reads a stored theme after hydration, so the first paint of a public booking
 * page falls back to the system theme until the client effect runs. This keeps the first paint on
 * the configured theme and lets a reload use the same storage key immediately.
 */
export function BookingPageThemeScript({
  theme,
  themeBasis,
  nonce,
  isEmbedMode,
}: BookingPageThemeScriptProps): JSX.Element | null {
  // Embeds keep their own storage key and let the parent decide the theme.
  if (isEmbedMode || !theme || !themeBasis || !SUPPORTED_THEMES.has(theme)) {
    return null;
  }

  return (
    <script
      nonce={nonce}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: The bootstrap must run before hydration
      dangerouslySetInnerHTML={{ __html: getBookingPageThemeScript({ theme, themeBasis }) }}
    />
  );
}

export function getBookingPageThemeScript({
  theme,
  themeBasis,
}: {
  theme: string;
  themeBasis: string;
}): string {
  // The storage key is shared with getThemeProviderProps for standalone booking pages.
  const storageKey = JSON.stringify(`booking-theme:${themeBasis}`).replace(/</g, "\\u003c");
  const themeValue = JSON.stringify(theme);
  return `(function(){try{localStorage.setItem(${storageKey},${themeValue});var c=document.documentElement.classList;c.remove("light","dark");c.add(${themeValue});}catch(e){}})();`;
}
