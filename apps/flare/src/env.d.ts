import type { AuthEnv } from "./server/auth.ts";

declare global {
  namespace Cloudflare {
    interface Env extends AuthEnv {}
  }
}
