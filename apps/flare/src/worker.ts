import astro from "@astrojs/cloudflare/entrypoints/server";
import { BookingService } from "./server/bookings.ts";
import { GoogleCalendar } from "./server/google.ts";
import { getSettings } from "./server/settings.ts";

export default {
  fetch: astro.fetch,
  async scheduled(_event: ScheduledController, env: Cloudflare.Env): Promise<void> {
    const settings = await getSettings(env.DB);
    const service = new BookingService({
      db: env.DB,
      calendar: new GoogleCalendar(env),
      settings,
      secret: env.TOKEN_ENCRYPTION_KEY,
    });
    await service.recover(5);
  },
};
