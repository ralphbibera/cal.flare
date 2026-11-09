"use client";

import { ThemeProvider } from "next-themes";
import type { JSX, ReactNode } from "react";

type BookingPageProviderThemeProps = {
  children: ReactNode;
  theme: string | null | undefined;
  themeBasis: string | null | undefined;
  nonce?: string;
};

// Storage keys may contain user-controlled segments (usernames, hashed links).
function sanitizeStorageKey(storageKey: string): string {
  return storageKey.replace(/[^A-Za-z0-9_\-:.@+%]/g, "_");
}

/**
 * Applies the organizer's booking-page theme while the server HTML is rendered.
 *
 * next-themes writes the chosen theme into the document through its inline script, so the first
 * paint already uses the configured theme instead of the system theme until hydration.
 */
export function BookingPageProviderTheme({
  children,
  theme,
  themeBasis,
  nonce,
}: BookingPageProviderThemeProps): JSX.Element {
  const defaultTheme = theme === "light" || theme === "dark" ? theme : "system";
  const storageKey = sanitizeStorageKey(`booking-theme:${themeBasis ?? "default"}:${defaultTheme}`);

  return (
    <ThemeProvider
      key={storageKey}
      storageKey={storageKey}
      forcedTheme={defaultTheme === "system" ? undefined : defaultTheme}
      defaultTheme={defaultTheme}
      enableSystem
      enableColorScheme={false}
      attribute="class"
      nonce={nonce}>
      {/* color-scheme makes background:transparent not work in iframe which is required by embed. */}
      <style
        nonce={nonce}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Static color-scheme rule shared with the app theme provider
        dangerouslySetInnerHTML={{ __html: ".dark{color-scheme:dark}" }}
      />
      {children}
    </ThemeProvider>
  );
}
