import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCustomerAndCheckoutSession } from "../../lib/getCustomerAndCheckoutSession";

vi.mock("../../lib/getCustomerAndCheckoutSession");
vi.mock("@calcom/features/auth/lib/sendVerificationRequest", () => ({ default: vi.fn() }));
vi.mock("../../lib/VerificationTokenService", () => ({ VerificationTokenService: { create: vi.fn() } }));

type CustomerAndCheckoutSession = Awaited<ReturnType<typeof getCustomerAndCheckoutSession>>;

describe("paymentCallback stripeCustomerId lookup on D1", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-stripe-customer-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../apps/web/cloudflare.config")).default;
    runtime = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(persistTo, "v3"),
      workers: [
        {
          config: {
            name: worker.name,
            compatibilityDate: worker.compatibilityDate,
            compatibilityFlags: worker.compatibilityFlags,
            env: { DB: worker.env.DB },
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
              },
            },
          },
        },
      ],
    });
    db = await runtime.getD1Database("DB");
    await db
      .prepare(`INSERT INTO users (id, uuid, email, username, metadata) VALUES
      (1, 'other', 'other@example.invalid', 'other', '{"stripeCustomerId":"cus_other"}'),
      (2, 'nested', 'nested@example.invalid', 'nested', '{"billing":{"stripeCustomerId":"cus_nested"}}'),
      (3, 'target', 'target@example.invalid', 'target', '{"stripeCustomerId":"cus_target","isPremium":false}'),
      (4, 'empty', 'empty@example.invalid', 'empty', null)`)
      .run();
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function redirectFor(customerId: string) {
    vi.mocked(getCustomerAndCheckoutSession).mockResolvedValue({
      stripeCustomer: { id: customerId, email: null, metadata: { username: "premium" } },
      checkoutSession: { payment_status: "unpaid" },
    } as unknown as CustomerAndCheckoutSession);
    const redirect = vi.fn();
    const res = {
      redirect: redirect.mockReturnValue({ end: vi.fn() }),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as NextApiResponse;
    const req = {
      method: "GET",
      url: "/api/integrations/stripepayment/paymentCallback",
      query: { callbackUrl: "/premium", checkoutSessionId: "cs_test" },
    } as unknown as NextApiRequest;
    const { default: handler } = await import("../paymentCallback");
    await withD1Database({ DB: db }, () => handler(req, res));
    return { redirect, res };
  }

  it("finds the user whose top-level metadata holds the Stripe customer id", async () => {
    const { redirect } = await redirectFor("cus_target");
    const url = new URL(redirect.mock.calls[0][0]);
    expect(url.searchParams.get("email")).toBe("target@example.invalid");
    expect(url.searchParams.get("paymentStatus")).toBe("unpaid");
  });

  it("does not match the id nested under another property", async () => {
    const { redirect, res } = await redirectFor("cus_nested");
    expect(redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
