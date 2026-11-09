import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BookingPageProviderTheme } from "../BookingPageProviderTheme";

describe("BookingPageProviderTheme", () => {
  it("applies a configured theme before hydration", () => {
    const markup = renderToStaticMarkup(
      <BookingPageProviderTheme theme="dark" themeBasis="alice" nonce="test-nonce">
        <span>booking</span>
      </BookingPageProviderTheme>
    );

    expect(markup).toContain("c.add('dark')");
    expect(markup).toContain('nonce="test-nonce"');
    expect(markup).toContain(".dark{color-scheme:dark}");
  });

  it("keeps the system theme when the organizer has no concrete theme", () => {
    const markup = renderToStaticMarkup(
      <BookingPageProviderTheme theme={null} themeBasis="alice">
        <span>booking</span>
      </BookingPageProviderTheme>
    );

    expect(markup).toContain("booking-theme:alice:system");
    expect(markup).toContain("prefers-color-scheme: dark");
  });

  it("sanitizes the storage key", () => {
    const markup = renderToStaticMarkup(
      <BookingPageProviderTheme theme={null} themeBasis="a/b c">
        <span>booking</span>
      </BookingPageProviderTheme>
    );

    expect(markup).toContain("booking-theme:a_b_c:system");
  });
});
