import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { z } from "zod";

export const WEB_SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

export const WEB_SESSION_PATH = "/api/auth/get-session";
export const WEB_SESSION_TIMEOUT_MS = 3000;

const webSessionSchema = z.object({
  user: z.object({ id: z.number().int().positive(), email: z.string().min(1) }),
});

export type CalWebSession = z.infer<typeof webSessionSchema>["user"];

// The web app owns the session table in D1, which API v2 on PostgreSQL cannot read. A Workers rewrite replaces this HTTP hop with a service binding.
@Injectable()
export class CalWebSessionClient {
  private readonly logger = new Logger("CalWebSessionClient");

  constructor(private readonly config: ConfigService) {}

  async getSession(request: Pick<Request, "headers">): Promise<CalWebSession | null> {
    const cookie = this.sessionCookies(request.headers.cookie);
    if (!cookie) return null;

    const webAppUrl = this.config.get<string>("app.baseUrl");
    if (!webAppUrl) return null;

    try {
      const url = new URL(WEB_SESSION_PATH, webAppUrl);
      // Redirects are not followed so the cookies can never leave the configured web origin.
      const response = await fetch(url, {
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(WEB_SESSION_TIMEOUT_MS),
      });
      if (response.status !== 200) return null;

      const parsed = webSessionSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.user : null;
    } catch (error) {
      this.logger.warn(`Web session lookup failed: ${error instanceof Error ? error.name : "unknown error"}`);
      return null;
    }
  }

  private sessionCookies(header: string | undefined): string | null {
    if (!header) return null;
    const kept = header
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => WEB_SESSION_COOKIE_NAMES.some((name) => pair.startsWith(`${name}=`)));
    return kept.length > 0 ? kept.join("; ") : null;
  }
}
