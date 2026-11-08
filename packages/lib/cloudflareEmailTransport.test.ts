import { ErrorCode } from "@calcom/lib/errorCodes";
import { createTransport } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { cloudflareEmailTransport, withCloudflareEmail } from "./cloudflareEmailTransport";

type DeliveredMessage = { from: string; to: string; raw: Uint8Array };
type EmailBinding = (message: DeliveredMessage) => Promise<void>;

const mail = {
  from: '"Cal.flare" <notifications@example.com>',
  to: "guest@example.net",
  cc: "copy@example.net",
  bcc: "hidden@example.net",
  replyTo: "organizer@example.com",
  subject: "Booking confirmed",
  text: "Your booking is confirmed.",
  html: "<p>Your booking is confirmed.</p>",
};

function decode(raw: Uint8Array): string {
  return new TextDecoder().decode(raw);
}

describe("cloudflareEmailTransport", () => {
  it("builds one MIME message for every envelope recipient and strips the Bcc header", async () => {
    const messages: { from: string; to: string; raw: string }[] = [];
    const binding: EmailBinding = async ({ from, to, raw }: DeliveredMessage) => {
      messages.push({ from, to, raw: decode(raw) });
    };
    const transporter = createTransport(cloudflareEmailTransport);

    await withCloudflareEmail(binding, () => transporter.sendMail(mail));

    expect(messages.map(({ from, to }) => [from, to])).toEqual([
      ["notifications@example.com", "guest@example.net"],
      ["notifications@example.com", "copy@example.net"],
      ["notifications@example.com", "hidden@example.net"],
    ]);
    expect(new Set(messages.map(({ raw }) => raw)).size).toBe(1);

    const [raw] = messages.map((message) => message.raw);
    expect(raw).toMatch(/^From: "Cal\.flare" <notifications@example\.com>$/m);
    expect(raw).toMatch(/^To: [^\r\n]*guest@example\.net/m);
    expect(raw).toMatch(/^Cc: [^\r\n]*copy@example\.net/m);
    expect(raw).toMatch(/^Reply-To: organizer@example\.com$/m);
    expect(raw).toContain("Subject: Booking confirmed");
    expect(raw).toContain("Your booking is confirmed.");
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).not.toContain("hidden@example.net");
  });

  it("keeps delivery running through waitUntil after the caller returns", async () => {
    const delivered = Promise.withResolvers<void>();
    const binding = vi.fn<EmailBinding>(async () => {
      await delivered.promise;
    });
    const waitUntil = vi.fn<(promise: Promise<void>) => void>();
    const sent = Promise.withResolvers<unknown>();
    const transporter = createTransport(cloudflareEmailTransport);

    const response = withCloudflareEmail(
      binding,
      () => {
        sent.resolve(transporter.sendMail({ ...mail, bcc: undefined }));
        return "response";
      },
      waitUntil
    );

    expect(response).toBe("response");
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const background = waitUntil.mock.calls[0][0];
    let settled = false;
    void background.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(binding).toHaveBeenCalledTimes(2));
    expect(binding.mock.calls.map(([message]) => message.to)).toEqual([
      "guest@example.net",
      "copy@example.net",
    ]);
    expect(settled).toBe(false);

    delivered.resolve();
    await background;
    expect(settled).toBe(true);
    await expect(sent.promise).resolves.toMatchObject({ messageId: expect.any(String) });
  });

  it("reports a missing EMAIL binding without sending", async () => {
    const transporter = createTransport(cloudflareEmailTransport);

    await expect(transporter.sendMail(mail)).rejects.toMatchObject({
      code: ErrorCode.InternalServerError,
      message: "EMAIL binding is required for email delivery",
    });
  });
});
