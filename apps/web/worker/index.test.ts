import { Readable } from "node:stream";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { createTransport } from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchHandler } = vi.hoisted(() => ({ fetchHandler: vi.fn<() => Promise<Response>>() }));

vi.mock("cloudflare:email", () => ({
  EmailMessage: class {
    constructor(
      public from: string,
      public to: string,
      public raw: ReadableStream<Uint8Array>
    ) {}
  },
}));
vi.mock("virtual:calflare-static-assets", () => ({ default: {} }));
vi.mock("vinext/server/fetch-handler", () => ({ default: { fetch: fetchHandler } }));
vi.mock("@sentry/cloudflare", () => ({ withSentry: (_options: unknown, handler: unknown) => handler }));
vi.mock("@calcom/prisma/d1", () => ({
  withD1Database: (_env: unknown, callback: () => unknown) => callback(),
}));
vi.mock("../sentry.server.config", () => ({ getSentryOptions: vi.fn() }));
vi.mock("./static-assets", () => ({
  withStaticAssets: (env: unknown) => env,
  frameStaticAsset: (response: Response) => response,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
  for (const name of ["RESEND_API_KEY", "EMAIL_SERVER", "EMAIL_SERVER_HOST"]) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Worker email delivery", () => {
  async function request(
    EMAIL?: { send(message: { from: string; to: string; raw: ReadableStream<Uint8Array> }): Promise<void> },
    attachments?: Parameters<ReturnType<typeof createTransport>["sendMail"]>[0]["attachments"]
  ) {
    const { serverConfig } = await import("@calcom/lib/serverConfig");
    const mailer = createTransport(serverConfig.transport);
    const sent = Promise.withResolvers<unknown>();
    fetchHandler.mockImplementation(async () => {
      void mailer
        .sendMail({
          from: "notifications@example.com",
          to: "guest@example.net",
          subject: "Sign in",
          text: "Your sign-in link",
          attachments,
        })
        .then(sent.resolve, sent.resolve);
      return new Response("Accepted");
    });
    const { default: worker } = await import("./index");
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const response = await worker.fetch(
      new Request("https://cal.example/auth"),
      { EMAIL } as unknown as Parameters<typeof worker.fetch>[1],
      { waitUntil } as unknown as Parameters<typeof worker.fetch>[2]
    );
    return { response, waitUntil, sent: sent.promise };
  }

  it("keeps MIME building and delivery alive after returning the response", async () => {
    const content = new Readable({ read() {} });
    const delivered = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const messages: { from: string; to: string; raw: string }[] = [];
    const send = vi.fn(async (message: { from: string; to: string; raw: ReadableStream<Uint8Array> }) => {
      messages.push({ ...message, raw: await new Response(message.raw).text() });
      started.resolve();
      await delivered.promise;
    });
    const { response, waitUntil, sent } = await request({ send }, [{ filename: "link.txt", content }]);
    try {
      expect(await response.text()).toBe("Accepted");
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      let settled = false;
      const background = Promise.all(waitUntil.mock.calls.map(([promise]) => promise)).then(() => {
        settled = true;
      });
      content.push("sign-in attachment");
      content.push(null);
      await started.promise;
      expect(settled).toBe(false);
      expect(messages).toEqual([
        expect.objectContaining({ from: "notifications@example.com", to: "guest@example.net" }),
      ]);
      expect(messages[0].raw).toContain("Subject: Sign in");
      expect(messages[0].raw).toContain("Your sign-in link");
      expect(messages[0].raw).toContain("filename=link.txt");
      delivered.resolve();
      await background;
      expect(await sent).toMatchObject({ messageId: expect.any(String) });
    } finally {
      content.push(null);
      delivered.resolve();
      await sent;
      content.destroy();
    }
  });

  it("reports missing EMAIL bindings through sendMail", async () => {
    const { sent } = await request();
    expect(await sent).toMatchObject({
      code: ErrorCode.InternalServerError,
      message: "EMAIL binding is required for email delivery",
    });
  });
});
