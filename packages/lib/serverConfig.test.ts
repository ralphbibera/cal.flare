import { createTransport } from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send, bindings } = vi.hoisted(() => {
  const send = vi.fn<(message: { from: string; to: string; raw: Uint8Array }) => Promise<void>>();
  const bindings: { EMAIL?: { send: typeof send } } = { EMAIL: { send } };
  return { send, bindings };
});

const mail = {
  from: '"Cal.flare" <notifications@example.com>',
  to: "guest@example.net",
  replyTo: "organizer@example.com",
  subject: "Booking confirmed",
  text: "Your booking is confirmed.",
  html: "<p>Your booking is confirmed.</p>",
};

async function configuredMailer() {
  const { serverConfig } = await import("./serverConfig");
  const { withCloudflareEmail } = await import("./cloudflareEmailTransport");
  const mailer = createTransport(serverConfig.transport);
  return {
    sendMail(payload: Parameters<typeof mailer.sendMail>[0]) {
      const binding = bindings.EMAIL;
      if (!binding) return mailer.sendMail(payload);
      return withCloudflareEmail(binding.send, () => mailer.sendMail(payload));
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const name of ["RESEND_API_KEY", "EMAIL_SERVER", "EMAIL_SERVER_HOST", "EMAIL_SERVER_PORT"]) {
    vi.stubEnv(name, "");
  }
  bindings.EMAIL = { send };
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
  send.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mail transport", () => {
  it.each([
    undefined,
    { userAgent: "Node.js/24" },
  ])("retains sendmail outside Workers (%j)", async (navigator) => {
    vi.stubGlobal("navigator", navigator);
    const { serverConfig } = await import("./serverConfig");
    expect(serverConfig.transport).toEqual({ sendmail: true, newline: "unix", path: "/usr/sbin/sendmail" });
  });

  it("defaults to Cloudflare and preserves MIME content and envelope recipients without exposing Bcc", async () => {
    const payloads: string[] = [];
    send.mockImplementation(async (message) => {
      payloads.push(new TextDecoder().decode(message.raw));
    });
    const transporter = await configuredMailer();
    await transporter.sendMail({
      ...mail,
      cc: "copy@example.net",
      bcc: "hidden@example.net",
      headers: { "X-Cal-Booking": "booking-123" },
      icalEvent: {
        method: "REQUEST",
        content:
          "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:booking-123\r\nSEQUENCE:2\r\nEND:VEVENT\r\nEND:VCALENDAR",
      },
      attachments: [{ filename: "notes.txt", content: "booking notes" }],
    });

    expect(send.mock.calls.map(([message]) => [message.from, message.to])).toEqual([
      ["notifications@example.com", "guest@example.net"],
      ["notifications@example.com", "copy@example.net"],
      ["notifications@example.com", "hidden@example.net"],
    ]);
    for (const raw of payloads) {
      expect(raw).toContain('From: "Cal.flare" <notifications@example.com>');
      expect(raw).toContain("Reply-To: organizer@example.com");
      expect(raw).toContain("X-Cal-Booking: booking-123");
      expect(raw).toContain("Content-Type: text/plain");
      expect(raw).toContain("Content-Type: text/html");
      expect(raw).toMatch(/Content-Type: text\/calendar;[^\r\n]*method=REQUEST/i);
      expect(raw).toContain("SEQUENCE:2");
      expect(raw).toContain("filename=notes.txt");
      expect(raw).not.toMatch(/^Bcc:/m);
      expect(raw).not.toContain("hidden@example.net");
    }
    expect(new Set(payloads).size).toBe(1);
  });

  it("preserves cancellation calendar MIME", async () => {
    let raw = "";
    send.mockImplementation(async (message) => {
      raw = new TextDecoder().decode(message.raw);
    });
    await (await configuredMailer()).sendMail({
      ...mail,
      icalEvent: { method: "CANCEL", content: "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR" },
    });
    expect(raw).toMatch(/Content-Type: text\/calendar;[^\r\n]*method=CANCEL/i);
    expect(raw).toContain("METHOD:CANCEL");
  });

  it("reports provider failure without falling back to another transport", async () => {
    const failure = new Error("Email quota exceeded");
    send.mockRejectedValue(failure);
    await expect((await configuredMailer()).sendMail(mail)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports a missing EMAIL binding", async () => {
    bindings.EMAIL = undefined;
    await expect((await configuredMailer()).sendMail(mail)).rejects.toThrow("EMAIL binding is required");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps concurrent requests' delivery bindings separate", async () => {
    const { serverConfig } = await import("./serverConfig");
    const { withCloudflareEmail } = await import("./cloudflareEmailTransport");
    const transporter = createTransport(serverConfig.transport);
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    await Promise.all([
      withCloudflareEmail(first, () => transporter.sendMail({ ...mail, to: "first@example.net" })),
      withCloudflareEmail(second, () => transporter.sendMail({ ...mail, to: "second@example.net" })),
    ]);
    expect(first).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: "first@example.net" }));
    expect(second).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: "second@example.net" }));
  });

  it("attempts every envelope recipient before reporting a partial delivery failure", async () => {
    const failure = new Error("Recipient rejected");
    const pending = Promise.withResolvers<void>();
    send.mockRejectedValueOnce(failure);
    send.mockReturnValueOnce(pending.promise);
    let settled = false;
    const result = (await configuredMailer()).sendMail({ ...mail, cc: "copy@example.net" }).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([message]) => message.to)).toEqual(["guest@example.net", "copy@example.net"]);
    expect(settled).toBe(false);
    pending.resolve();
    expect(await result).toBe(failure);
  });

  it.each([
    { from: "", to: mail.to, replyTo: "" },
    { from: mail.from, to: "" },
  ])("rejects a missing sender or recipient before delivery", async (envelope) => {
    await expect((await configuredMailer()).sendMail({ ...mail, ...envelope })).rejects.toThrow(
      "Email sender and recipients are required"
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("retains Resend precedence over configured SMTP", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("EMAIL_SERVER", "smtp://smtp.example.com:587");
    const { serverConfig } = await import("./serverConfig");
    expect(serverConfig.transport).toMatchObject({
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      auth: { user: "resend", pass: "test-resend-key" },
    });
  });

  it("retains SMTP URL precedence over a configured host", async () => {
    vi.stubEnv("EMAIL_SERVER", "smtp://smtp.example.com:587");
    vi.stubEnv("EMAIL_SERVER_HOST", "other.example.com");
    const { serverConfig } = await import("./serverConfig");
    expect(serverConfig.transport).toBe("smtp://smtp.example.com:587");
  });

  it("retains configured SMTP host options", async () => {
    vi.stubEnv("EMAIL_SERVER_HOST", "smtp.example.com");
    vi.stubEnv("EMAIL_SERVER_PORT", "465");
    vi.stubEnv("EMAIL_SERVER_USER", "mailer");
    vi.stubEnv("EMAIL_SERVER_PASSWORD", "test-password");
    const { serverConfig } = await import("./serverConfig");
    expect(serverConfig.transport).toMatchObject({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "mailer", pass: "test-password" },
    });
  });

  it("sends through explicitly configured SMTP instead of Cloudflare", async () => {
    let received = "";
    const server = createServer((socket) => {
      socket.write("220 localhost ESMTP\r\n");
      let buffer = "";
      let data = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes("\r\n")) {
          const end = buffer.indexOf("\r\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (data && line !== ".") {
            received += `${line}\r\n`;
            continue;
          }
          if (line === "DATA") {
            data = true;
            socket.write("354 Send message\r\n");
            continue;
          }
          if (line === "QUIT") {
            socket.end("221 Bye\r\n");
            continue;
          }
          data = false;
          socket.write("250 OK\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SMTP test server did not bind");
    try {
      vi.stubEnv("EMAIL_SERVER", `smtp://127.0.0.1:${address.port}`);
      const { serverConfig } = await import("./serverConfig");
      await createTransport(serverConfig.transport).sendMail(mail);
      expect(received).toContain("Subject: Booking confirmed");
      expect(received).toContain("Your booking is confirmed.");
      expect(send).not.toHaveBeenCalled();
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

import { once } from "node:events";
import { createServer } from "node:net";
