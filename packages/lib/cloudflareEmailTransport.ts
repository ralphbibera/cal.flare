import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Transport } from "nodemailer";

type EmailDelivery = (message: { from: string; to: string; raw: Uint8Array }) => Promise<void>;
type WaitUntil = (promise: Promise<void>) => void;
const delivery = new AsyncLocalStorage<{ send: EmailDelivery; waitUntil?: WaitUntil }>();

export function withCloudflareEmail<T>(sender: EmailDelivery, callback: () => T, waitUntil?: WaitUntil): T {
  return delivery.run({ send: sender, waitUntil }, callback);
}

export const cloudflareEmailTransport: Transport<{ messageId: string }> = {
  name: "CloudflareEmail",
  version: "1.0.0",
  send(mail, callback): void {
    const info = { messageId: mail.message.messageId() };
    const deliver = async (): Promise<void> => {
      const send = delivery.getStore()?.send;
      if (!send) {
        throw new ErrorWithCode(
          ErrorCode.InternalServerError,
          "EMAIL binding is required for email delivery"
        );
      }
      const envelope = mail.message.getEnvelope();
      const from = envelope.from;
      if (!from || envelope.to.length === 0) {
        throw new ErrorWithCode(ErrorCode.BadRequest, "Email sender and recipients are required");
      }
      // Keep Nodemailer's calendar MIME and omit Bcc headers from every recipient's copy.
      const raw = await mail.message.build();
      const results = await Promise.allSettled(envelope.to.map((to) => send({ from, to, raw })));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    const task = deliver().then(
      () => callback(null, info),
      (error: unknown) =>
        callback(
          error instanceof Error
            ? error
            : new ErrorWithCode(ErrorCode.InternalServerError, "Cloudflare email delivery failed"),
          info
        )
    );
    // MIME building can outlive the response before the native sender is reached.
    delivery.getStore()?.waitUntil?.(task);
  },
};
