import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

// The Worker renders emails in the SSR environment, where react-dom/server resolves to the
// edge renderer. Exercise that renderer here too.
vi.mock("react-dom/server", async () => import("react-dom/server.edge"));

import renderEmail from "./renderEmail";

const language = ((key: string) => key) as unknown as TFunction;
const verificationEmailLink = "http://localhost:3000/api/auth/verify-email?token=abc123";

describe("verification email rendering", () => {
  it("renders the verification link and copy through the Worker renderer", async () => {
    const html = await renderEmail("VerifyAccountEmail", {
      language,
      user: { name: "Pending", email: "pending@calflare.test" },
      verificationEmailLink,
    });

    expect(html).toContain(`href="${verificationEmailLink}"`);
    expect(html).toContain("verify_email_email_header");
    expect(html).toContain('xmlns="http://www.w3.org/1999/xhtml"');
  });
});
