import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingPageThemeScript, getBookingPageThemeScript } from "../BookingPageThemeScript";

describe("BookingPageThemeScript", () => {
  it("applies the configured theme before hydration", () => {
    const markup = renderToStaticMarkup(
      <BookingPageThemeScript theme="dark" themeBasis="alice" nonce="test-nonce" />
    );

    expect(markup).toContain('nonce="test-nonce"');
    expect(markup).toContain('localStorage.setItem("booking-theme:alice","dark")');
    expect(markup).toContain('c.remove("light","dark");c.add("dark")');
  });

  it("does not render without a concrete theme", () => {
    expect(renderToStaticMarkup(<BookingPageThemeScript theme={null} themeBasis="alice" />)).toBe("");
    expect(renderToStaticMarkup(<BookingPageThemeScript theme="system" themeBasis="alice" />)).toBe("");
    expect(renderToStaticMarkup(<BookingPageThemeScript theme="dark" themeBasis={null} />)).toBe("");
  });

  it("leaves the theme to the embed parent in embed mode", () => {
    expect(renderToStaticMarkup(<BookingPageThemeScript theme="dark" themeBasis="alice" isEmbedMode />)).toBe(
      ""
    );
  });

  it("escapes a theme basis that could close the script tag", () => {
    const script = getBookingPageThemeScript({ theme: "dark", themeBasis: "</script><script>" });

    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script>");
  });
});
